import { randomBytes } from "node:crypto";
import { json, one, run } from "../db.ts";
import { now } from "../clock.ts";
import type { Business } from "../config.ts";
import { discountLabel, formatINR, type PriceBreakdown } from "../pricing/engine.ts";
import type { DeliveryInfo } from "../ai/types.ts";
import type { Dispatch } from "../orders/repo.ts";

export interface InvoicePayload {
  number: string;
  date: number;
  orderId: number;
  voucherId: string;
  business: Business;
  buyer: { name: string | null; businessName: string | null; gstin: string | null; handle: string };
  delivery: Partial<DeliveryInfo>;
  breakdown: PriceBreakdown;
}

export interface Invoice {
  id: number;
  order_id: number;
  number: string;
  erp_voucher_id: string;
  status: "draft" | "final" | "cancelled";
  public_token: string;
  payload: InvoicePayload;
  created_at: number;
}

export async function createInvoice(payload: InvoicePayload): Promise<Invoice> {
  const token = randomBytes(18).toString("base64url");
  const r = await one(
    "INSERT INTO invoices (order_id, number, erp_voucher_id, status, public_token, payload, created_at) VALUES ($1, $2, $3, 'draft', $4, $5, $6) RETURNING *",
    payload.orderId, payload.number, payload.voucherId, token, JSON.stringify(payload), now(),
  );
  return { ...(r as unknown as Invoice), payload };
}

function toInvoice(r: Record<string, unknown> | undefined): Invoice | null {
  return r ? { ...(r as unknown as Invoice), payload: json.parse<InvoicePayload>(r.payload, {} as InvoicePayload) } : null;
}

export async function getInvoice(id: number): Promise<Invoice | null> {
  return toInvoice(await one("SELECT * FROM invoices WHERE id=$1", id));
}

/** Buyers open invoices by an unguessable token, so one buyer cannot browse another's bills. */
export async function getInvoiceByToken(token: string): Promise<Invoice | null> {
  return toInvoice(await one("SELECT * FROM invoices WHERE public_token=$1", token));
}

export function invoiceUrl(baseUrl: string, inv: Pick<Invoice, "public_token">): string {
  return `${baseUrl}/i/${inv.public_token}`;
}

export async function setInvoiceStatus(id: number, status: Invoice["status"]): Promise<void> {
  await run("UPDATE invoices SET status=$1 WHERE id=$2", status, id);
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const amountInWords = (n: number): string => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]} ${ones[x % 10]}`.trim());
  const three = (x: number) => (x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred ${two(x % 100)}`.trim() : two(x));
  let x = Math.round(n);
  if (x === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(x / 1e7); x %= 1e7;
  const lakh = Math.floor(x / 1e5); x %= 1e5;
  const thousand = Math.floor(x / 1e3); x %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (x) parts.push(three(x));
  return parts.join(" ");
};

export function renderInvoiceHtml(inv: Invoice, dispatch?: Dispatch | null): string {
  const p = inv.payload;
  const b = p.breakdown;
  const t = b.totals;
  const intra = b.taxMode === "intra";
  const d = p.delivery;
  const date = new Date(p.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const status = inv.status === "final" ? "" : `<div class="stamp">${inv.status === "draft" ? "DRAFT, awaiting owner approval" : "CANCELLED"}</div>`;
  const rows = b.lines
    .map(
      (l, i) => `<tr>
        <td>${i + 1}</td><td>${esc(l.name)}<div class="muted">${esc(l.sku)}</div></td><td>${esc(l.hsn)}</td>
        <td class="n">${l.qty} ${esc(l.unit)}</td><td class="n">${formatINR(l.unitPrice)}</td>
        <td class="n">${l.lineDiscount || l.billDiscountShare ? "−" + formatINR(l.lineDiscount + l.billDiscountShare) : "-"}</td>
        <td class="n">${formatINR(l.taxable)}</td><td class="n">${l.gstRate}%</td>
        <td class="n">${formatINR(l.gst + l.cess)}</td><td class="n">${formatINR(l.total)}</td></tr>`,
    )
    .join("");
  const taxRows = intra
    ? `<tr><td>CGST</td><td class="n">${formatINR(t.cgst)}</td></tr><tr><td>SGST</td><td class="n">${formatINR(t.sgst)}</td></tr>`
    : `<tr><td>IGST</td><td class="n">${formatINR(t.igst)}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tax Invoice ${esc(p.number)}</title>
<style>
  :root { --ink:#1d2433; --muted:#667085; --line:#e4e7ec; --bg:#ffffff; --accent:#0f5f4a; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f2f4f7; color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .sheet { max-width: 900px; margin: 24px auto; background:var(--bg); padding: 32px; border:1px solid var(--line); border-radius: 8px; position:relative; }
  h1 { font-size: 20px; margin:0 0 4px; letter-spacing: .02em; }
  .muted { color:var(--muted); font-size:12px; }
  .head { display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap; border-bottom:2px solid var(--accent); padding-bottom:16px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin:16px 0; }
  .box { border:1px solid var(--line); border-radius:6px; padding:12px; }
  .box h3 { margin:0 0 6px; font-size:12px; text-transform:uppercase; color:var(--muted); letter-spacing:.06em; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:8px 6px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { font-size:12px; color:var(--muted); font-weight:600; background:#f9fafb; }
  .n { text-align:right; white-space:nowrap; font-variant-numeric: tabular-nums; }
  .totals { margin-left:auto; width: min(360px, 100%); margin-top:12px; }
  .totals td { border:none; padding:4px 6px; }
  .grand td { font-weight:700; font-size:16px; border-top:2px solid var(--ink); padding-top:8px; }
  .stamp { position:absolute; top:24px; right:24px; color:#b42318; border:2px solid #b42318; padding:4px 10px; font-weight:700; transform:rotate(-4deg); border-radius:4px; background:#fff; }
  .actions { text-align:center; margin: 0 0 24px; }
  button { font:inherit; padding:8px 16px; border-radius:6px; border:1px solid var(--line); background:#fff; cursor:pointer; }
  @media (max-width: 640px) { .sheet { margin:0; border-radius:0; padding:16px; } .grid { grid-template-columns:1fr; } .stamp { position:static; display:inline-block; margin-bottom:12px; } }
  @media print { body { background:#fff; } .sheet { border:none; margin:0; } .actions { display:none; } }
</style></head>
<body>
<div class="sheet">
  ${status}
  <div class="head">
    <div><h1>${esc(p.business.name)}</h1><div>${esc(p.business.address)}</div><div class="muted">GSTIN ${esc(p.business.gstin)} · ${esc(p.business.phone)}</div></div>
    <div><h1>TAX INVOICE</h1><div>No. <strong>${esc(p.number)}</strong></div><div>Date ${esc(date)}</div><div class="muted">Order #${p.orderId} · Tally voucher ${esc(p.voucherId.slice(0, 8))}</div></div>
  </div>
  <div class="grid">
    <div class="box"><h3>Bill to</h3><strong>${esc(p.buyer.businessName || d.businessName || p.buyer.name || p.buyer.handle)}</strong>
      <div>${esc(p.buyer.gstin || d.gstin ? "GSTIN " + (p.buyer.gstin || d.gstin) : "GSTIN not provided")}</div></div>
    <div class="box"><h3>Ship to</h3><div>${esc(d.line)}</div><div>${esc([d.city, d.state, d.pincode].filter(Boolean).join(", "))}</div>
      <div class="muted">${esc([d.contactName, d.phone].filter(Boolean).join(" · "))}</div><div class="muted">Place of supply: ${esc(d.state)}</div></div>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Discount</th><th class="n">Taxable</th><th class="n">GST</th><th class="n">Tax</th><th class="n">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <table class="totals">
    <tr><td>Gross</td><td class="n">${formatINR(t.gross)}</td></tr>
    ${t.lineDiscount ? `<tr><td>Line discounts</td><td class="n">−${formatINR(t.lineDiscount)}</td></tr>` : ""}
    ${t.billDiscount ? `<tr><td>Discount (${esc(discountLabel(t))})</td><td class="n">−${formatINR(t.billDiscount)}</td></tr>` : ""}
    <tr><td>Taxable value</td><td class="n">${formatINR(t.taxable)}</td></tr>
    ${taxRows}
    ${t.cess ? `<tr><td>Cess</td><td class="n">${formatINR(t.cess)}</td></tr>` : ""}
    ${t.roundOff ? `<tr><td>Round off</td><td class="n">${t.roundOff > 0 ? "+" : "−"}${formatINR(Math.abs(t.roundOff))}</td></tr>` : ""}
    <tr class="grand"><td>Total</td><td class="n">${formatINR(t.grandTotal)}</td></tr>
  </table>
  <p><strong>Amount in words:</strong> Rupees ${esc(amountInWords(t.grandTotal))} only</p>
  ${dispatch ? `<div class="box" style="margin:12px 0"><h3>Dispatch details</h3>
    <div>Dispatched through <strong>${esc(dispatch.transporter)}</strong> · Vehicle no. <strong>${esc(dispatch.vehicleNo)}</strong></div>
    <div class="muted">${esc([
      dispatch.lrNo ? `LR / docket ${dispatch.lrNo}` : null,
      dispatch.ewayBillNo ? `E-way bill ${dispatch.ewayBillNo}` : null,
      dispatch.driverName || dispatch.driverPhone ? `Driver ${[dispatch.driverName, dispatch.driverPhone].filter(Boolean).join(", ")}` : null,
      `Dispatched ${new Date(dispatch.dispatchedAt).toLocaleDateString("en-IN")}`,
      dispatch.deliveredAt ? `Delivered ${new Date(dispatch.deliveredAt).toLocaleDateString("en-IN")}` : dispatch.expectedDelivery ? `Expected ${dispatch.expectedDelivery}` : null,
    ].filter(Boolean).join(" · "))}</div></div>` : ""}
  <div class="grid">
    <div class="box"><h3>Payment</h3><div>${esc(p.business.bank)}</div><div class="muted">${esc(p.business.paymentTerms)}</div></div>
    <div class="box"><h3>Calculation</h3><div class="muted">${b.steps.map(esc).join("<br>")}</div><div class="muted">Pricing rules ${esc(b.ruleVersion)}</div></div>
  </div>
</div>
<div class="actions"><button onclick="print()">Print / Save as PDF</button></div>
</body></html>`;
}
