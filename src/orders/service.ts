/**
 * Orchestrates a buyer conversation through the order flow:
 *
 *   buyer DM -> requirement -> stock reserved (ledger) -> priced (rules engine)
 *   -> quote drafted -> OWNER APPROVES -> buyer confirms -> delivery details
 *   -> bill drafted in the ERP -> OWNER APPROVES -> invoice sent -> buyer saved
 *
 * The assistant only reads messages and writes wording. Every number comes from the
 * ledger or the pricing engine, and every step change goes through the state machine.
 * Messages from the same buyer are handled one at a time (withLock, which also works
 * across serverless instances), so a buyer who sends three messages quickly cannot
 * race their own order.
 */
import { settings, loadBusiness } from "../config.ts";
import { audit, raiseAlert } from "../audit.ts";
import { all, one, run, withDbLock } from "../db.ts";
import { assistant } from "../ai/index.ts";
import type { DeliveryInfo, RequestedItem, Understanding, Wording, WordingContext } from "../ai/types.ts";
import { isValidGstin, NO_GST, stateFromCity, stateFromGstin } from "../ai/fallback.ts";
import { sendToBuyer } from "../channels/index.ts";
import type { MessageRow, Buyer, DeliveryDraft, Dispatch, Order, OrderLine, PendingItem, Quote, QuoteLine } from "./repo.ts";
import {
  activeOrder, addressText, createOrder, defaultAddress, formatAddress, getBuyer, getOrder, isReturningBuyer, lastOutbound,
  latestShippedOrder, logInbound, ordersInProgress, saveAddress, saveOrder, seenExternal, updateBuyer, upsertBuyer,
} from "./repo.ts";
import { allProducts, getProduct, matchProduct, type Product } from "./matcher.ts";
import {
  atp, cancelWaitlistForOrder, claimWaitlist, liveReservationsFor, markBilled, moveHolds, oversold,
  releaseExcept, releaseOrder, reserve, setWaitlist, sweepExpired, waitingFor, waitlistForOrder,
} from "../inventory/ledger.ts";
import { discountLabel, formatINR, loadRules, priceOrder, type PriceBreakdown, type PriceContext, type PriceInputLine } from "../pricing/engine.ts";
import { createApproval, decide, getApproval, type Approval } from "../approvals/repo.ts";
import { erp, syncFromErp } from "../erp/mockTally.ts";
import { createInvoice, getInvoice, invoiceUrl, setInvoiceStatus } from "../invoices/invoices.ts";
import { now } from "../clock.ts";

// ---------- per-buyer serialization (in-process queue + database lease for multi-instance) ----------

const queues = new Map<number, Promise<unknown>>();
function withLock<T>(buyerId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(buyerId) ?? Promise.resolve();
  const run_ = prev.catch(() => undefined).then(() => withDbLock(`buyer:${buyerId}`, fn));
  const tail = run_.catch(() => undefined);
  queues.set(buyerId, tail);
  tail.then(() => {
    if (queues.get(buyerId) === tail) queues.delete(buyerId);
  });
  return run_;
}

// ---------- canned replies (no commitments, so they go out without approval) ----------

const replies = {
  askRequirement: (biz: string) =>
    `Hello! Thank you for reaching out to ${biz}. Please share your requirement: product, brand/model and quantity for each item.`,
  ackChecking: "Thank you! We are checking availability and the best price for you. We'll confirm shortly.",
  ackQuotePending: "We are finalising your quote and will share it with you shortly.",
  ackBillPending: "Your invoice is being finalised and will reach you shortly.",
  ackPreparingBill: "Thank you! We are preparing your invoice now; you will receive it shortly.",
  escalated: "Good question. Let me check with the team and get back to you shortly.",
  declined: "No problem, thank you for considering us. Message us anytime for your next requirement.",
  stockChanged: "Stock levels changed while you were deciding, so we are sending you an updated quote shortly.",
  waitlisted: (items: string) => `You are on our priority waitlist for ${items}. We will message you as soon as stock arrives.`,
  rechecking: "Let me re-check availability and pricing for you. We'll confirm shortly.",
  askDelivery:
    "Thank you for confirming! Please share your delivery and billing details, for example:\n" +
    "Business name: Acme Retail Pvt Ltd\nGSTIN: 29ABCDE1234F1Z5\nAddress: 12 MG Road, Bengaluru, Karnataka 560001\nContact: Ravi, 9876543210",
  askSameAddress: (addr: string) =>
    `Thank you for confirming! Shall we deliver to the same address as last time?\n${addr}\n\nReply YES to confirm, or send the new address.`,
  quoteExpired: (ref: string) =>
    `Your quote ${ref} has expired and the reserved stock was released. Reply YES if you would still like it and we will re-check availability.`,
  negotiating: "Let me discuss with the owner and come back to you with our best possible price.",
};

const TRACK = /\b(where is my (order|parcel|delivery|consignment|material|goods|shipment)|track(ing)?|order status|status of (my )?order|dispatched\??|vehicle (no|number)|lr (no|number)|kab (aayega|milega|tak)|delivery kab|when will (it|my order) (arrive|reach|come))\b/i;

// ---------- public API ----------

export interface InboundArgs {
  channel: string;
  handle: string;
  name?: string | null;
  text: string;
  externalId?: string | null;
}

export async function handleInbound(args: InboundArgs): Promise<MessageRow[]> {
  const text = args.text.trim();
  if (!text) return [];
  const buyer = await upsertBuyer(args.channel, args.handle, args.name ?? null);
  return withLock(buyer.id, async () => {
    if (args.externalId && (await seenExternal(args.externalId))) return []; // duplicate webhook delivery
    const out: MessageRow[] = [];
    const active = await activeOrder(buyer.id);
    // "Where is my order?" from a buyer with nothing open: answer from their last billed order.
    if ((!active || (active.state === "AWAITING_REQUIREMENT" && !active.lines.length && !active.pending.length)) && TRACK.test(text)) {
      const shipped = await latestShippedOrder(buyer.id);
      if (shipped) {
        await logInbound(buyer.id, shipped.id, text, args.externalId ?? null);
        out.push(await sendToBuyer({ buyer, orderId: shipped.id, text: await trackingText(shipped), kind: "chat" }));
        return out;
      }
    }
    let order = active ?? (await createOrder(buyer));
    const lastBot = await lastOutbound(buyer.id);
    await logInbound(buyer.id, order.id, text, args.externalId ?? null);
    const u = await assistant().understand(text, {
      state: order.state,
      lastBotMessage: lastBot,
      productNames: (await allProducts()).map((p) => p.name),
    });
    await audit(`ai:${assistant().mode}`, "understand", `order:${order.id}`, u);
    const reply = async (t: string, kind: "chat" | "ack" = "chat") => {
      out.push(await sendToBuyer({ buyer, orderId: order.id, text: t, kind }));
    };

    switch (order.state) {
      case "AWAITING_REQUIREMENT": {
        if (u.intent === "question") return escalate(buyer, order, u, out);
        const items = withBareQuantity(u.items, text, order.pending);
        if (items.length) await onRequirement(buyer, order, items, out);
        else if (order.pending.length) await reply(await clarifyPending(order.pending));
        else await reply(replies.askRequirement(loadBusiness().name));
        return out;
      }
      case "QUOTE_PENDING_APPROVAL": {
        if (u.intent === "requirement" && u.items.length) await onRequirement(buyer, order, u.items, out);
        else if (u.intent === "decline") await cancelOrder(buyer, order, out);
        else if (u.intent === "question") await escalate(buyer, order, u, out);
        else await reply(replies.ackQuotePending, "ack");
        return out;
      }
      case "AWAITING_BUYER_CONFIRMATION": {
        if (u.intent === "accept") await onQuoteAccepted(buyer, order, out);
        else if (u.intent === "negotiate") await onNegotiate(buyer, order, u, text, out);
        else if (u.intent === "decline") await cancelOrder(buyer, order, out);
        else if (u.intent === "requirement" && u.items.length) await onRequirement(buyer, order, u.items, out);
        else await escalate(buyer, order, u, out);
        return out;
      }
      case "AWAITING_DELIVERY":
        await onDelivery(buyer, order, u, text, out);
        return out;
      case "BILL_PENDING_APPROVAL":
        if (u.intent === "question") await escalate(buyer, order, u, out);
        else await reply(replies.ackBillPending, "ack");
        return out;
      case "WAITLISTED":
      case "EXPIRED": {
        if (u.intent === "requirement" && u.items.length) {
          await cancelWaitlistForOrder(order.id);
          await onRequirement(buyer, order, u.items, out);
        } else if (u.intent === "decline") {
          await cancelOrder(buyer, order, out);
        } else if (order.state === "EXPIRED" && u.intent === "accept") {
          await reply(replies.rechecking, "ack");
          order = await draftQuote(buyer, order, { origin: "requote" });
        } else if (u.intent === "question") {
          await escalate(buyer, order, u, out);
        } else if (order.state === "WAITLISTED") {
          await reply(replies.waitlisted(order.lines.map((l) => l.name).join(", ")), "ack");
        } else {
          await reply(replies.quoteExpired(quoteRef(order)));
        }
        return out;
      }
      default:
        return out;
    }
  });
}

async function lockedApproval<T>(approvalId: number, fn: (a: Approval, order: Order, buyer: Buyer) => Promise<T>): Promise<T> {
  const first = await getApproval(approvalId);
  const order0 = await getOrder(first.order_id);
  return withLock(order0.buyer_id, async () => {
    const a = await getApproval(approvalId);
    if (a.status !== "pending") throw new Error(`This draft is already ${a.status}. Refresh to see the latest one.`);
    const order = await getOrder(a.order_id);
    return fn(a, order, await getBuyer(order.buyer_id));
  });
}

export async function ownerApprove(approvalId: number, editedText?: string | null): Promise<{ status: "sent" | "redrafted"; message?: MessageRow }> {
  return lockedApproval(approvalId, async (approval, order, buyer) => {
    const text = editedText?.trim() || approval.draft_text;

    if (approval.gate === "quote") {
      if (order.state !== "QUOTE_PENDING_APPROVAL") throw new Error(`Order is ${order.state}, not waiting for a quote approval`);
      const quote = approval.payload.quote as Quote;
      const offered = quote.lines.filter((l) => l.offered > 0);
      if (offered.length) {
        const held = await moveHolds(order.id, "QUOTED_HOLD", settings.quotedHoldMs);
        const short = offered.filter((l) => (held.find((h) => h.sku === l.sku)?.held ?? 0) < l.offered);
        if (short.length) {
          // The hold lapsed while waiting for approval and someone else took the stock.
          await decide(approval.id, "superseded", { note: "stock changed before approval" });
          await raiseAlert("stock_changed", `Stock for ${short.map((s) => s.name).join(", ")} changed before the quote for order #${order.id} was approved. A fresh draft is ready.`, `order:${order.id}`);
          await draftQuote(buyer, order, { origin: "requote" });
          return { status: "redrafted" as const };
        }
      }
      if (!(await decide(approval.id, "approved", { sentText: text }))) throw new Error("This draft was already decided");
      const message = await sendToBuyer({ buyer, orderId: order.id, text, kind: "quote", approvalId: approval.id });
      await saveOrder(order, { state: offered.length ? "AWAITING_BUYER_CONFIRMATION" : "WAITLISTED" });
      return { status: "sent" as const, message };
    }

    // gate === "bill"
    if (order.state !== "BILL_PENDING_APPROVAL") throw new Error(`Order is ${order.state}, not waiting for a bill approval`);
    const invoice = await getInvoice(approval.payload.invoiceId as number);
    if (!invoice) throw new Error("Invoice not found");
    if (approval.payload.blocking) throw new Error(`Cannot send this bill: ${(approval.payload.warnings as string[]).join(" ")}`);
    try {
      await erp.postVoucher(invoice.erp_voucher_id);
    } catch (err) {
      await raiseAlert("erp_post_failed", `Tally refused invoice ${invoice.number}: ${(err as Error).message}`, `order:${order.id}`);
      throw err;
    }
    await markBilled(order.id);
    await syncFromErp();
    await setInvoiceStatus(invoice.id, "final");
    if (!(await decide(approval.id, "approved", { sentText: text }))) throw new Error("This draft was already decided");
    const message = await sendToBuyer({ buyer, orderId: order.id, text, kind: "invoice", approvalId: approval.id });
    await saveOrder(order, { state: "CLOSED" });
    await audit("system", "sale_closed", `order:${order.id}`, { invoice: invoice.number, total: invoice.payload.breakdown.totals.grandTotal });
    return { status: "sent" as const, message };
  });
}

/** Owner rejects a draft: the assistant rewrites it following the note (and any extra discount). */
export async function ownerReject(approvalId: number, note: string, extraDiscountPct?: number | null): Promise<void> {
  await lockedApproval(approvalId, async (approval, order, buyer) => {
    await decide(approval.id, "rejected", { note });
    if (extraDiscountPct !== undefined && extraDiscountPct !== null) order = await saveOrder(order, { extra_discount_pct: checkPct(extraDiscountPct) });
    await redraft(approval, order, buyer, { ownerNote: note || null, previousDraft: approval.draft_text });
  });
}

export interface PricingChanges {
  /** New unit price per SKU; null or 0 removes the override (back to the normal price). */
  prices?: Record<string, number | null>;
  extraDiscountPct?: number | null;
  /** true = remove all discounts (rule discounts and the extra %); false = restore them. */
  waiveDiscounts?: boolean;
  /** Change the negotiated special price %. */
  negotiatedPct?: number | null;
}

/**
 * Owner changes the numbers on a pending quote or bill: unit prices, extra discount,
 * remove all discounts. Re-priced immediately; a fresh draft (same wording) replaces
 * the old one for review. The order keeps these settings, so the bill uses them too.
 */
export async function ownerUpdatePricing(approvalId: number, changes: PricingChanges): Promise<Approval> {
  return lockedApproval(approvalId, async (approval, order, buyer) => {
    const overrides = { ...order.price_overrides };
    const skus = new Set(order.lines.map((l) => l.sku));
    for (const [sku, price] of Object.entries(changes.prices ?? {})) {
      if (!skus.has(sku)) throw new Error(`${sku} is not on this order`);
      if (price === null || price === 0) {
        delete overrides[sku];
        continue;
      }
      if (!(Number.isFinite(price) && price > 0 && price < 1e9)) throw new Error("Prices must be positive numbers");
      overrides[sku] = Math.round(price * 100) / 100;
    }
    const patch: Partial<Order> = { price_overrides: overrides };
    if (changes.extraDiscountPct !== undefined && changes.extraDiscountPct !== null) patch.extra_discount_pct = checkPct(changes.extraDiscountPct);
    if (changes.waiveDiscounts !== undefined) {
      patch.waive_discounts = changes.waiveDiscounts;
      if (changes.waiveDiscounts) patch.extra_discount_pct = 0;
    }
    if (changes.negotiatedPct !== undefined && changes.negotiatedPct !== null) {
      const pct = checkPct(changes.negotiatedPct);
      patch.negotiation = { pct, rounds: order.negotiation?.rounds ?? [] };
    }
    order = await saveOrder(order, patch);
    await audit("owner", "update_pricing", `order:${order.id}`, changes);
    // The new draft supersedes this one; wording is kept, only the numbers change.
    await redraft(approval, order, buyer, { keepWords: approval.payload.words as Wording | undefined });
    return (await one<Approval>("SELECT * FROM approvals WHERE order_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1", order.id))!;
  });
}

/** Shortcut kept for the discount box: same as ownerUpdatePricing with only the extra %. */
export async function ownerSetDiscount(approvalId: number, pct: number): Promise<Approval> {
  return ownerUpdatePricing(approvalId, { extraDiscountPct: pct, ...(pct > 0 ? { waiveDiscounts: false } : {}) });
}

// ---------- dispatch / transport ----------

export interface DispatchInput {
  transporter: string;
  vehicleNo: string;
  lrNo?: string | null;
  ewayBillNo?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  expectedDelivery?: string | null;
  notes?: string | null;
}

/** MH12AB1234, DL1CAB1234, KA05MN4321, and Bharat series 22BH1234AA. */
export function normalizeVehicleNo(v: string): string {
  const s = v.toUpperCase().replace(/[\s\-.]/g, "");
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(s) && !/^\d{2}BH\d{4}[A-Z]{1,2}$/.test(s)) {
    throw new Error(`"${v}" doesn't look like a vehicle number (e.g. MH12AB1234 or 22BH1234AA)`);
  }
  return s;
}

const clean = (v: string | null | undefined) => (v ?? "").trim() || null;

/** Owner records the transporter / vehicle. The buyer is sent the details. Can be called again to correct them. */
export async function ownerDispatch(orderId: number, input: DispatchInput): Promise<Order> {
  const o = await getOrder(orderId);
  return withLock(o.buyer_id, async () => {
    let order = await getOrder(orderId);
    if (order.state !== "CLOSED" && order.state !== "DISPATCHED") throw new Error(`Order #${orderId} is ${order.state}; only billed orders can be dispatched`);
    const transporter = clean(input.transporter);
    if (!transporter) throw new Error("Transporter name is required");
    const ewayBillNo = clean(input.ewayBillNo)?.replace(/\s/g, "") ?? null;
    if (ewayBillNo && !/^\d{12}$/.test(ewayBillNo)) throw new Error("E-way bill number should be 12 digits");
    const driverPhone = clean(input.driverPhone)?.replace(/[\s\-]/g, "") ?? null;
    if (driverPhone && !/^(\+91)?[6-9]\d{9}$/.test(driverPhone)) throw new Error("Driver phone should be a 10-digit mobile number");
    const expectedDelivery = clean(input.expectedDelivery);
    if (expectedDelivery && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDelivery)) throw new Error("Expected delivery should be a date");
    const t = now();
    const dispatch: Dispatch = {
      transporter,
      vehicleNo: normalizeVehicleNo(input.vehicleNo ?? ""),
      lrNo: clean(input.lrNo),
      ewayBillNo,
      driverName: clean(input.driverName),
      driverPhone,
      expectedDelivery,
      notes: clean(input.notes),
      dispatchedAt: order.dispatch?.dispatchedAt ?? t,
      updatedAt: t,
      deliveredAt: null,
    };
    const update = order.state === "DISPATCHED";
    order = await saveOrder(order, { state: "DISPATCHED", dispatch });
    await audit("owner", update ? "dispatch_updated" : "dispatched", `order:${order.id}`, dispatch);
    await sendToBuyer({ buyer: await getBuyer(order.buyer_id), orderId: order.id, text: await trackingText(order, update ? "updated" : "new"), kind: "dispatch" });
    return order;
  });
}

export async function ownerMarkDelivered(orderId: number): Promise<Order> {
  const o = await getOrder(orderId);
  return withLock(o.buyer_id, async () => {
    let order = await getOrder(orderId);
    if (order.state !== "DISPATCHED" || !order.dispatch) throw new Error(`Order #${orderId} is not in transit`);
    order = await saveOrder(order, { state: "DELIVERED", dispatch: { ...order.dispatch, deliveredAt: now(), updatedAt: now() } });
    await audit("owner", "delivered", `order:${order.id}`);
    await sendToBuyer({
      buyer: await getBuyer(order.buyer_id), orderId: order.id, kind: "dispatch",
      text: `Your order #${order.id} has been delivered. Thank you for your business! Message us anytime for your next requirement.`,
    });
    return order;
  });
}

const fmtDate = (d: string | number) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

async function trackingText(order: Order, mode: "new" | "updated" | "status" = "status"): Promise<string> {
  const inv = order.invoice_id ? await getInvoice(order.invoice_id) : null;
  const ref = `order #${order.id}${inv ? ` (invoice ${inv.number})` : ""}`;
  const d = order.dispatch;
  if (order.state === "CLOSED" || !d) return `Your ${ref} is billed and being packed. We will share the vehicle and transporter details as soon as it is dispatched.`;
  if (order.state === "DELIVERED") return `Your ${ref} was delivered on ${fmtDate(d.deliveredAt!)}. Thank you!`;
  const lines = [
    mode === "new" ? `Good news! Your ${ref} has been dispatched.` : mode === "updated" ? `Updated dispatch details for your ${ref}:` : `Your ${ref} is on the way.`,
    `Transporter: ${d.transporter}`,
    `Vehicle no.: ${d.vehicleNo}`,
    d.lrNo ? `LR / docket no.: ${d.lrNo}` : null,
    d.ewayBillNo ? `E-way bill no.: ${d.ewayBillNo}` : null,
    d.driverName || d.driverPhone ? `Driver: ${[d.driverName, d.driverPhone].filter(Boolean).join(", ")}` : null,
    `Dispatched on: ${fmtDate(d.dispatchedAt)}`,
    d.expectedDelivery ? `Expected delivery: ${fmtDate(d.expectedDelivery)}` : null,
    d.notes ? `Note: ${d.notes}` : null,
    inv ? `Invoice: ${invoiceUrl(settings.publicUrl, inv)}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

function checkPct(pct: number): number {
  if (!(Number.isFinite(pct) && pct >= 0 && pct <= 50)) throw new Error("Extra discount must be a number between 0 and 50 (%)");
  return Math.round(pct * 100) / 100;
}

async function redraft(
  approval: Approval, order: Order, buyer: Buyer,
  opts: { ownerNote?: string | null; previousDraft?: string | null; keepWords?: Wording },
): Promise<void> {
  if (approval.gate === "quote") {
    await draftQuote(buyer, order, { origin: order.origin === "waitlist" ? "waitlist" : "dm", ...opts });
  } else {
    const old = await getInvoice(approval.payload.invoiceId as number);
    if (old) {
      await erp.cancelVoucher(old.erp_voucher_id);
      await setInvoiceStatus(old.id, "cancelled");
    }
    await prepareBill(buyer, order, opts);
  }
}

/**
 * Periodic housekeeping: expire holds, tell buyers whose quotes lapsed, offer freed
 * stock to the waitlist in order, and resync stock from the ERP (raising an alert if
 * stock was sold elsewhere and promises now exceed it). Safe to run from several
 * instances at once.
 */
export async function sweep(): Promise<{ expired: number; offered: number; oversold: { sku: string; over: number }[] }> {
  const expired = await sweepExpired();
  const orderIds = [...new Set(expired.map((r) => r.order_id))];
  for (const id of orderIds) {
    const o = await getOrder(id);
    await withLock(o.buyer_id, async () => {
      const order = await getOrder(id);
      const buyer = await getBuyer(order.buyer_id);
      if (order.state === "AWAITING_BUYER_CONFIRMATION") {
        await saveOrder(order, { state: "EXPIRED" });
        await sendToBuyer({ buyer, orderId: order.id, text: replies.quoteExpired(quoteRef(order)), kind: "chat" });
      } else if (order.state === "QUOTE_PENDING_APPROVAL") {
        await raiseAlert("hold_lapsed", `Quote for order #${order.id} (${buyer.name ?? buyer.handle}) waited too long for approval, so its stock hold was released. Approving it will re-check stock.`, `order:${order.id}`);
      }
    });
  }

  await syncFromErp();
  const over = await oversold();
  for (const o of over) {
    const open = await one("SELECT 1 FROM alerts WHERE kind='oversold' AND ref=$1 AND NOT resolved", `sku:${o.sku}`);
    if (!open) {
      await raiseAlert("oversold", `${(await getProduct(o.sku)).name}: ${o.over} more units are promised than Tally has in stock (sold outside this system?). Review held and committed orders.`, `sku:${o.sku}`);
    }
  }

  const offered = await offerToWaitlist();
  return { expired: expired.length, offered, oversold: over };
}

// ---------- requirement -> quote ----------

/** "500" on its own answers "how many?" for the item we are waiting on. */
function withBareQuantity(items: RequestedItem[], text: string, pending: PendingItem[]): RequestedItem[] {
  if (items.length) return items;
  const needQty = pending.find((p) => p.qty === null);
  const m = text.match(/^\s*(\d[\d,]*)\s*(k)?\s*(units?|pcs|pieces|nos)?\s*\.?\s*$/i);
  if (needQty && m) {
    const qty = Number(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    return [{ productText: needQty.productText, brand: null, qty }];
  }
  return items;
}

async function clarifyPending(pending: PendingItem[]): Promise<string> {
  const lines: string[] = [];
  for (const p of pending) {
    if (p.candidates.length) {
      const names = (await Promise.all(p.candidates.map(getProduct))).map((x) => x.name).join(", ");
      lines.push(`• For "${p.productText}"${p.qty ? ` (${p.qty} pcs)` : ""}, which one? We have: ${names}.`);
    } else {
      lines.push(`• How many units of ${p.sku ? (await getProduct(p.sku)).name : p.productText}?`);
    }
  }
  return `Thank you! Just to be sure:\n${lines.join("\n")}`;
}

async function onRequirement(buyer: Buyer, order: Order, items: RequestedItem[], out: MessageRow[]): Promise<Order> {
  const products = await allProducts();
  const pending: PendingItem[] = [...order.pending];
  const unknown: string[] = [];

  for (const item of items) {
    // First, does this answer an earlier "which one?" question?
    let answered = false;
    for (const p of pending.filter((x) => x.candidates.length)) {
      const m = matchProduct(item.productText, item.brand, products.filter((x) => p.candidates.includes(x.sku)));
      if (m.status === "matched") {
        p.sku = m.product.sku;
        p.candidates = [];
        p.qty = item.qty ?? p.qty;
        answered = true;
        break;
      }
    }
    if (answered) continue;
    const needQty = pending.find((p) => p.sku && p.qty === null);
    const m = matchProduct(item.productText, item.brand, products);
    if (m.status === "matched") {
      if (needQty && needQty.sku === m.product.sku) {
        needQty.qty = item.qty ?? needQty.qty;
      } else {
        const same = pending.find((p) => p.sku === m.product.sku);
        if (same) same.qty = item.qty ?? same.qty;
        else pending.push({ productText: item.productText, qty: item.qty, sku: m.product.sku, candidates: [] });
      }
    } else if (m.status === "ambiguous") {
      pending.push({ productText: item.productText, qty: item.qty, sku: null, candidates: m.candidates.map((c) => c.sku) });
    } else {
      unknown.push(item.productText);
    }
  }

  const reply = async (t: string) => {
    out.push(await sendToBuyer({ buyer, orderId: order.id, text: t, kind: "chat" }));
  };
  const resolved = pending.filter((p) => p.sku && p.qty);
  const unresolved = pending.filter((p) => !(p.sku && p.qty));

  if (unknown.length) {
    const cats = [...new Set(products.map((p) => p.category))].join(", ");
    await reply(`Sorry, we don't stock ${unknown.map((u) => `"${u}"`).join(", ")}. We deal in: ${cats}.`);
  }
  if (unresolved.length) {
    order = await saveOrder(order, { pending });
    await reply(await clarifyPending(unresolved));
    return order;
  }
  if (!resolved.length) {
    order = await saveOrder(order, { pending: [] });
    if (!unknown.length) await reply(replies.askRequirement(loadBusiness().name));
    return order;
  }

  // Merge with what the order already had (buyer changing one item keeps the others).
  const lines = new Map<string, OrderLine>(order.state === "AWAITING_REQUIREMENT" ? [] : order.lines.map((l) => [l.sku, l]));
  for (const p of resolved) {
    const prod = products.find((x) => x.sku === p.sku)!;
    lines.set(prod.sku, { sku: prod.sku, name: prod.name, requested: p.qty! });
  }
  order = await saveOrder(order, { pending: [], lines: [...lines.values()] });
  out.push(await sendToBuyer({ buyer, orderId: order.id, text: replies.ackChecking, kind: "ack" }));
  return draftQuote(buyer, order, { origin: "dm" });
}

function quoteRef(order: Order): string {
  return `Q${order.id}-v${order.quote_version}`;
}

/** Everything the owner (and negotiation) changed on this order, applied the same way to quote and bill. */
function priceContext(order: Order, buyer: Buyer, buyerState: string | null): PriceContext {
  return {
    buyerKey: buyer.handle,
    buyerState,
    extraDiscountPct: order.extra_discount_pct,
    unitPriceOverrides: order.price_overrides,
    waiveDiscounts: order.waive_discounts,
    negotiatedPct: order.negotiation?.pct ?? 0,
  };
}

async function priceInputs(lines: { sku: string; qty: number }[]): Promise<PriceInputLine[]> {
  const products = await allProducts();
  return lines.map((l) => {
    const p = products.find((x) => x.sku === l.sku);
    if (!p) throw new Error(`Unknown SKU ${l.sku}`);
    return { sku: p.sku, name: p.name, category: p.category, hsn: p.hsn, unit: p.unit, qty: l.qty, listPrice: p.unit_price, gstRate: p.gst_rate };
  });
}

function quoteBlock(ref: string, lines: QuoteLine[], b: PriceBreakdown | null): string {
  const out: string[] = [`Quote ${ref}`];
  for (const l of lines) {
    const priced = b?.lines.find((x) => x.sku === l.sku);
    if (!priced || l.offered === 0) {
      out.push(`• ${l.name}: out of stock right now (${l.requested} ${l.unit} on priority waitlist)`);
      continue;
    }
    const net = priced.gross - priced.lineDiscount;
    const disc = priced.lineDiscountPct ? ` less ${priced.lineDiscountPct}%` : "";
    const qty = l.shortfall ? `${l.offered} of ${l.requested} ${l.unit} available` : `${l.offered} ${l.unit}`;
    out.push(`• ${l.name}: ${qty} × ${formatINR(priced.unitPrice)}${disc} = ${formatINR(net)}`);
    if (l.shortfall) out.push(`   balance ${l.shortfall} ${l.unit} on priority waitlist`);
  }
  if (b) {
    const t = b.totals;
    out.push("");
    out.push(`Subtotal: ${formatINR(t.subtotal)}`);
    if (t.billDiscount) out.push(`Discount (${discountLabel(t)}): −${formatINR(t.billDiscount)}`);
    const rates = [...new Set(b.lines.map((l) => l.gstRate))].join("/");
    out.push(`GST @${rates}%: ${formatINR(t.gst)}`);
    if (t.cess) out.push(`Cess: ${formatINR(t.cess)}`);
    if (t.roundOff) out.push(`Round off: ${t.roundOff > 0 ? "+" : "−"}${formatINR(Math.abs(t.roundOff))}`);
    out.push(`Total payable: ${formatINR(t.grandTotal)}`);
    out.push("");
    out.push(`Stock is reserved for you for ${Math.round(settings.quotedHoldMs / 3_600_000)} hours after this quote. Payment terms: ${loadBusiness().paymentTerms}.`);
  }
  return out.join("\n");
}

/** Reserve stock for the order's lines, price what was reserved, and queue a draft for the owner. */
async function draftQuote(
  buyer: Buyer,
  order: Order,
  opts: {
    origin: "dm" | "requote" | "waitlist";
    ownerNote?: string | null;
    previousDraft?: string | null;
    keepWords?: Wording;
    /** Set when this draft is a counter-offer to a bargaining buyer. */
    negotiation?: NegotiationDraftInfo;
  },
): Promise<Order> {
  const products = await allProducts();
  const quoteLines: QuoteLine[] = [];
  for (const line of order.lines) {
    const r = await reserve(order.id, line.sku, line.requested, settings.draftHoldMs);
    const prod = products.find((p) => p.sku === line.sku)!;
    quoteLines.push({ sku: line.sku, name: line.name, unit: prod.unit, requested: line.requested, offered: r.reserved, shortfall: r.shortfall });
    await setWaitlist(buyer.id, order.id, line.sku, r.shortfall);
  }
  await releaseExcept(order.id, order.lines.map((l) => l.sku));
  for (const w of await waitlistForOrder(order.id)) {
    if (!order.lines.some((l) => l.sku === w.sku)) await setWaitlist(buyer.id, order.id, w.sku, 0);
  }

  const offered = quoteLines.filter((l) => l.offered > 0);
  const address = await defaultAddress(buyer.id);
  const breakdown = offered.length
    ? priceOrder(await priceInputs(offered.map((l) => ({ sku: l.sku, qty: l.offered }))), priceContext(order, buyer, address?.state ?? null))
    : null;

  // A redraft of a counter-offer (owner edited the price, rejected with a note) keeps its negotiation details.
  const negotiation = opts.negotiation ?? (order.negotiation?.rounds.length ? lastNegotiationInfo(order) : undefined);
  // Counter-offers keep bargaining wording even on a partial quote (the block still shows the waitlisted balance).
  const situation: WordingContext["situation"] = !offered.length
    ? "quote_unavailable"
    : negotiation && !negotiation.returningBuyer
      ? negotiation.final ? "final_offer" : "counter_offer"
      : offered.some((l) => l.shortfall > 0) || offered.length < quoteLines.length
        ? "quote_partial"
        : opts.origin === "waitlist"
          ? "quote_restocked"
          : "quote";

  const version = order.quote_version + 1;
  const ref = `Q${order.id}-v${version}`;
  const block = quoteBlock(ref, quoteLines, breakdown);
  const business = loadBusiness();
  const words = opts.keepWords ?? await assistant().wording({
    businessName: business.name,
    buyerName: buyer.name,
    tone: business.replyTone,
    situation,
    ownerNote: opts.ownerNote ?? null,
    previousDraft: opts.previousDraft ?? null,
    negotiationRound: negotiation?.round,
    buyerMessage: negotiation?.buyerText ?? null,
  });
  const text = `${words.intro}\n\n${block}\n\n${words.closing}`;
  const quote: Quote = { version, createdAt: now(), situation, lines: quoteLines, breakdown, block };

  order = await saveOrder(order, { state: "QUOTE_PENDING_APPROVAL", quote, quote_version: version });
  await createApproval(order.id, "quote", text, { quote, ref, words, negotiation }, opts.ownerNote ?? null);
  return order;
}

// ---------- negotiation (new buyers; every counter-offer is approved by the owner) ----------

export interface NegotiationDraftInfo {
  round: number;
  buyerText: string;
  askUnitPrice: number | null;
  askPct: number | null;
  previousPct: number;
  offeredPct: number;
  maxPct: number;
  final: boolean;
  returningBuyer: boolean;
  /** Buyer wants more than the limit allows. */
  overLimit: boolean;
}

function lastNegotiationInfo(order: Order): NegotiationDraftInfo {
  const rounds = order.negotiation!.rounds;
  const last = rounds.at(-1)!;
  return {
    round: rounds.length, buyerText: last.buyerText, askUnitPrice: last.askUnitPrice, askPct: last.askPct,
    previousPct: rounds.length > 1 ? rounds.at(-2)!.offeredPct : 0, offeredPct: order.negotiation!.pct,
    maxPct: negotiationLimit(order), final: last.final, returningBuyer: false, overLimit: false,
  };
}

function negotiationLimit(order: Order): number {
  const rules = loadRules().negotiation;
  if (!rules) return 0;
  const caps = order.lines.map((l) => rules.products?.[l.sku]?.maxDiscountPct ?? rules.maxDiscountPct);
  return Math.min(rules.maxDiscountPct, ...caps);
}

const roundHalf = (n: number) => Math.floor(n * 2) / 2;

/**
 * The buyer is bargaining over a quote we sent. New buyers get a counter-offer drafted
 * like an Indian wholesaler would: small first concession, a bit more, then a firm
 * final price, never beyond the owner's limit. If the buyer named a number inside the
 * next step, we meet them there instead of giving away the full step. Returning buyers
 * are left to the owner. Either way the owner approves before anything is sent.
 */
async function onNegotiate(buyer: Buyer, order: Order, u: Understanding, text: string, out: MessageRow[]): Promise<void> {
  const rules = loadRules().negotiation;
  const quote = order.quote;
  if (!quote?.breakdown) {
    await escalate(buyer, order, { ...u, question: text }, out);
    return;
  }
  const returning = await isReturningBuyer(buyer.id);
  const current = order.negotiation?.pct ?? 0;
  const max = negotiationLimit(order);
  const askUnitPrice = u.negotiation?.askUnitPrice ?? null;
  let askPct = u.negotiation?.askPct ?? null;
  const offeredLines = quote.breakdown.lines;
  if (askPct === null && askUnitPrice !== null && offeredLines.length === 1) {
    askPct = Math.round((1 - askUnitPrice / offeredLines[0].unitPrice) * 10000) / 100;
  }

  out.push(await sendToBuyer({ buyer, orderId: order.id, text: replies.negotiating, kind: "ack" }));

  if (!rules?.enabled || (rules.newClientsOnly && returning)) {
    // Existing customer: the owner decides personally. Same numbers, so they can adjust them in Approvals.
    await raiseAlert("negotiation", `${buyer.name ?? buyer.handle} (returning client) is asking for a better price on order #${order.id}: "${text}". Adjust the price in Approvals or approve to hold.`, `order:${order.id}`);
    await draftQuote(buyer, await saveOrder(order, { state: "QUOTE_PENDING_APPROVAL" }), {
      origin: "requote",
      negotiation: { round: 0, buyerText: text, askUnitPrice, askPct, previousPct: current, offeredPct: current, maxPct: max, final: false, returningBuyer: true, overLimit: false },
    });
    return;
  }

  const steps = [...rules.steps].sort((a, b) => a - b);
  const nextStep = Math.min(steps.find((s) => s > current) ?? max, max);
  let offered: number;
  if (current >= max) offered = max; // nothing left to give: hold firm at the final price
  else if (askPct !== null && askPct > current && askPct <= nextStep) offered = Math.max(roundHalf(askPct), Math.min(current + 0.5, max));
  else offered = nextStep;
  const final = offered >= max;
  const overLimit = current >= max || (askPct !== null && askPct > max);

  const round = (order.negotiation?.rounds.length ?? 0) + 1;
  const negotiation = {
    pct: offered,
    rounds: [...(order.negotiation?.rounds ?? []), { at: now(), buyerText: text, askUnitPrice, askPct, offeredPct: offered, final }],
  };
  order = await saveOrder(order, { state: "QUOTE_PENDING_APPROVAL", negotiation });
  if (overLimit) {
    await raiseAlert("negotiation", `${buyer.name ?? buyer.handle} wants more than your ${max}% negotiation limit on order #${order.id}${askPct !== null ? ` (asked about ${askPct}%)` : ""}. The draft holds at the final price; change it in Approvals if you want to go lower.`, `order:${order.id}`);
  }
  await draftQuote(buyer, order, {
    origin: "requote",
    negotiation: { round, buyerText: text, askUnitPrice, askPct, previousPct: current, offeredPct: offered, maxPct: max, final, returningBuyer: false, overLimit },
  });
}

// ---------- buyer accepts -> delivery -> bill ----------

async function onQuoteAccepted(buyer: Buyer, order: Order, out: MessageRow[]): Promise<void> {
  const quote = order.quote!;
  const held = await moveHolds(order.id, "COMMITTED", null);
  const short = quote.lines.filter((l) => l.offered > 0 && (held.find((h) => h.sku === l.sku)?.held ?? 0) < l.offered);
  if (short.length) {
    out.push(await sendToBuyer({ buyer, orderId: order.id, text: replies.stockChanged, kind: "ack" }));
    await draftQuote(buyer, await saveOrder(order, { state: "QUOTE_PENDING_APPROVAL" }), { origin: "requote" });
    return;
  }
  await saveOrder(order, { state: "AWAITING_DELIVERY", delivery: null });
  const saved = await defaultAddress(buyer.id);
  const text = saved ? replies.askSameAddress(formatAddress(saved)) : replies.askDelivery;
  out.push(await sendToBuyer({ buyer, orderId: order.id, text, kind: "chat" }));
}

const REQUIRED: { key: keyof DeliveryInfo; label: string }[] = [
  { key: "line", label: "street address" },
  { key: "pincode", label: "6-digit pincode" },
  { key: "state", label: "state" },
];

function deliverySummary(d: DeliveryDraft): string {
  return [
    d.businessName,
    isValidGstin(d.gstin) ? `GSTIN ${d.gstin}` : null,
    addressText(d) || null,
    [d.contactName, d.phone].filter(Boolean).join(", ") || null,
  ].filter(Boolean).join(" · ");
}

async function onDelivery(buyer: Buyer, order: Order, u: Understanding, rawText: string, out: MessageRow[]): Promise<void> {
  const reply = async (t: string, kind: "chat" | "ack" = "chat") => {
    out.push(await sendToBuyer({ buyer, orderId: order.id, text: t, kind }));
  };
  let delivery: DeliveryDraft = { ...(order.delivery ?? {}) };
  const saved = await defaultAddress(buyer.id);

  if (u.intent === "accept" && saved && !delivery.line) {
    delivery = {
      line: saved.line, city: saved.city, state: saved.state, pincode: saved.pincode,
      contactName: saved.contact_name, phone: saved.phone, gstin: buyer.gstin, businessName: buyer.business_name,
    };
  } else if (u.intent === "delivery" || NO_GST.test(rawText)) {
    for (const [k, v] of Object.entries(u.delivery ?? {})) {
      if (v) (delivery as Record<string, unknown>)[k] = typeof v === "string" ? v.trim() : v;
    }
    if (u.delivery?.gstin) delivery.gstinInvalid = null; // a new GSTIN replaces the bad one; re-checked below
  } else if (u.intent === "decline") {
    await cancelOrder(buyer, order, out);
    return;
  } else if (u.intent === "question") {
    await escalate(buyer, order, u, out);
    return;
  } else {
    await reply(saved ? replies.askSameAddress(formatAddress(saved)) : replies.askDelivery);
    return;
  }

  // Validate and fill in what can be inferred.
  if (delivery.gstin) {
    delivery.gstin = delivery.gstin.toUpperCase().replace(/\s/g, "");
    if (!isValidGstin(delivery.gstin)) {
      delivery.gstinInvalid = delivery.gstin;
      delivery.gstin = null;
    }
  }
  if (NO_GST.test(rawText)) delivery.gstinInvalid = null;
  delivery.state = delivery.state || stateFromCity(delivery.city) || stateFromGstin(delivery.gstin);
  if (!delivery.line && delivery.city) delivery.line = delivery.city;

  const missing = REQUIRED.filter((f) => !delivery[f.key]).map((f) => f.label);
  order = await saveOrder(order, { delivery });
  if (missing.length || delivery.gstinInvalid) {
    const got = deliverySummary(delivery);
    const lines = [got ? `Thank you, noted: ${got}.` : "Thank you!"];
    if (missing.length) lines.push(`Please also share the ${missing.join(", ")}.`);
    if (delivery.gstinInvalid) {
      lines.push(`The GSTIN "${delivery.gstinInvalid}" doesn't look right. It should be 15 characters, like 29ABCDE1234F1Z5. Please send the correct one, or reply "no GST" if you are not registered.`);
    }
    await reply(lines.join("\n"));
    return;
  }
  await saveAddress(buyer.id, delivery);
  await updateBuyer(buyer.id, { business_name: delivery.businessName, gstin: delivery.gstin });
  await reply(replies.ackPreparingBill, "ack");
  await prepareBill(await getBuyer(buyer.id), order, {});
}

/** Draft the invoice in the ERP from committed stock and the rules engine, then queue it for the owner. */
async function prepareBill(
  buyer: Buyer, order: Order, opts: { ownerNote?: string | null; previousDraft?: string | null; keepWords?: Wording },
): Promise<void> {
  await syncFromErp();
  const committed = (await liveReservationsFor(order.id)).filter((r) => r.state === "COMMITTED");
  if (!committed.length) throw new Error(`Order ${order.id} has no committed stock to bill`);
  const delivery = order.delivery ?? {};
  const warnings: string[] = [];
  let blocking = false;

  for (const o of (await oversold()).filter((x) => committed.some((c) => c.sku === x.sku))) {
    warnings.push(`Tally stock for ${(await getProduct(o.sku)).name} is ${o.over} short of what is promised.`);
    blocking = true;
  }

  const breakdown = priceOrder(await priceInputs(committed.map((r) => ({ sku: r.sku, qty: r.qty }))), priceContext(order, buyer, delivery.state ?? null));
  const quoted = order.quote?.breakdown;
  if (quoted && Math.abs(quoted.totals.taxable - breakdown.totals.taxable) > 0.005) {
    warnings.push(`Taxable value changed since the quote: ${formatINR(quoted.totals.taxable)} → ${formatINR(breakdown.totals.taxable)} (price, rule or discount change).`);
  }

  const t = breakdown.totals;
  const afterTaxDiscount = Math.abs(breakdown.lines.reduce((s, l) => s + l.billDiscountShare, 0) - t.billDiscount) < 0.005 ? 0 : t.billDiscount;
  const voucher = await erp.createSalesVoucherDraft({
    orderId: order.id,
    buyerName: delivery.businessName || buyer.business_name || buyer.name || buyer.handle,
    buyerGstin: delivery.gstin || buyer.gstin,
    placeOfSupply: delivery.state ?? "",
    lines: breakdown.lines.map((l) => ({ sku: l.sku, qty: l.qty, rate: l.unitPrice, taxable: l.taxable, tax: l.gst + l.cess })),
    adjustments: t.roundOff - afterTaxDiscount,
    grandTotal: t.grandTotal,
  });
  const erpTotal = await erp.computeVoucherTotal(voucher.voucherId);
  if (Math.abs(erpTotal - t.grandTotal) > 0.005) {
    warnings.push(`Tally computes ${formatINR(erpTotal)} but our rules give ${formatINR(t.grandTotal)}. Check the rules before sending.`);
    blocking = true;
  }

  const business = loadBusiness();
  const invoice = await createInvoice({
    number: voucher.number,
    date: now(),
    orderId: order.id,
    voucherId: voucher.voucherId,
    business,
    buyer: { name: buyer.name, businessName: delivery.businessName || buyer.business_name, gstin: delivery.gstin || buyer.gstin, handle: buyer.handle },
    delivery,
    breakdown,
  });

  const tax = breakdown.taxMode === "intra" ? `CGST ${formatINR(t.cgst)} + SGST ${formatINR(t.sgst)}` : `IGST ${formatINR(t.igst)}`;
  const block = [
    `Invoice ${voucher.number}`,
    ...breakdown.lines.map((l) => `• ${l.name}: ${l.qty} ${l.unit} = ${formatINR(l.taxable)} + GST ${formatINR(l.gst)}`),
    "",
    t.billDiscount ? `Discount (${discountLabel(t)}): −${formatINR(t.billDiscount)}` : null,
    `Taxable value: ${formatINR(t.taxable)}`,
    `Tax: ${tax}`,
    `Total: ${formatINR(t.grandTotal)}`,
    "",
    `Deliver to: ${addressText(delivery)}`,
    `View / download: ${invoiceUrl(settings.publicUrl, invoice)}`,
    `Payment: ${business.bank}`,
    `Terms: ${business.paymentTerms}`,
  ].filter((x) => x !== null).join("\n");
  const words = opts.keepWords ?? await assistant().wording({
    businessName: business.name,
    buyerName: buyer.name,
    tone: business.replyTone,
    situation: "bill",
    ownerNote: opts.ownerNote ?? null,
    previousDraft: opts.previousDraft ?? null,
  });
  const text = `${words.intro}\n\n${block}\n\n${words.closing}`;
  order = await saveOrder(await getOrder(order.id), { state: "BILL_PENDING_APPROVAL", invoice_id: invoice.id });
  await createApproval(order.id, "bill", text, { invoiceId: invoice.id, warnings, blocking, words }, opts.ownerNote ?? null);
  if (warnings.length) await raiseAlert("bill_check", `Order #${order.id}: ${warnings.join(" ")}`, `order:${order.id}`);
}

// ---------- other ----------

async function cancelOrder(buyer: Buyer, order: Order, out: MessageRow[]): Promise<void> {
  await releaseOrder(order.id, "buyer_declined");
  await cancelWaitlistForOrder(order.id);
  await run("UPDATE approvals SET status='superseded', decided_at=$1 WHERE order_id=$2 AND status='pending'", now(), order.id);
  await saveOrder(order, { state: "CANCELLED" });
  out.push(await sendToBuyer({ buyer, orderId: order.id, text: replies.declined, kind: "chat" }));
}

async function escalate(buyer: Buyer, order: Order, u: Understanding, out: MessageRow[]): Promise<MessageRow[]> {
  const q = u.question ?? "(see conversation)";
  await raiseAlert("buyer_question", `${buyer.name ?? buyer.handle} asked: ${q}`, `order:${order.id}`);
  out.push(await sendToBuyer({ buyer, orderId: order.id, text: replies.escalated, kind: "ack" }));
  return out;
}

/** Offer freed stock to waiting buyers, first come first served. */
async function offerToWaitlist(): Promise<number> {
  let offered = 0;
  const skus = await all<{ sku: string }>("SELECT DISTINCT sku FROM waitlist WHERE status='waiting'");
  for (const { sku } of skus) {
    for (const entry of await waitingFor(sku)) {
      if ((await atp(sku)) === 0) break;
      const buyer = await getBuyer(entry.buyer_id);
      // Wait until the buyer has no order in progress (including the one this backorder
      // came from), so their next "yes" cannot land on the wrong order.
      if ((await ordersInProgress(buyer.id)).length) continue;
      await withLock(buyer.id, async () => {
        const order = await getOrder(entry.order_id);
        if (order.state === "WAITLISTED") {
          const entries = await waitlistForOrder(order.id);
          const claimed = [];
          for (const e of entries) if (await claimWaitlist(e.id)) claimed.push(e);
          if (!claimed.length) return;
          const lines = await Promise.all(claimed.map(async (e) => ({ sku: e.sku, name: (await getProduct(e.sku)).name, requested: e.qty })));
          await draftQuote(buyer, await saveOrder(order, { lines }), { origin: "waitlist" });
        } else {
          if (!(await claimWaitlist(entry.id))) return;
          const fresh = await createOrder(buyer, "waitlist");
          const lines = [{ sku: entry.sku, name: (await getProduct(entry.sku)).name, requested: entry.qty }];
          await draftQuote(buyer, await saveOrder(fresh, { lines }), { origin: "waitlist" });
        }
        offered++;
      });
    }
  }
  return offered;
}

export async function productsWithAtp(): Promise<(Product & { atp: number })[]> {
  return Promise.all((await allProducts()).map(async (p) => ({ ...p, atp: await atp(p.sku) })));
}
