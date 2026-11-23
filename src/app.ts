/**
 * The HTTP app, shared by the local server (src/server.ts) and the Vercel function
 * (src/vercel.ts). Static pages live in public/.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { ROOT, settings, loadBusiness, isProduction } from "./config.ts";
import { all, one, run, wipeAll } from "./db.ts";
import { assistant } from "./ai/index.ts";
import { erp, syncFromErp } from "./erp/mockTally.ts";
import {
  handleInbound, ownerApprove, ownerDispatch, ownerMarkDelivered, ownerReject, ownerSetDiscount, ownerUpdatePricing, sweep,
  type PricingChanges,
} from "./orders/service.ts";
import { conversation, defaultAddress, findBuyer, getBuyer, getOrder, listOrders, activeOrder, formatAddress } from "./orders/repo.ts";
import type { Buyer } from "./orders/repo.ts";
import { listApprovals, approvalsForOrder } from "./approvals/repo.ts";
import { inventorySnapshot, reservationsFor, waitlistForOrder } from "./inventory/ledger.ts";
import { getInvoice, getInvoiceByToken, renderInvoiceHtml } from "./invoices/invoices.ts";
import { parseWebhook, whatsappEnabled } from "./channels/whatsapp.ts";
import { audit } from "./audit.ts";

export async function seedIfEmpty(): Promise<void> {
  const row = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM erp_items");
  if (!row || row.c === 0) await erp.seedFromCatalog();
  const p = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM products");
  if (!p || p.c === 0) await syncFromErp();
}

// ---------- access control ----------

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Everything under /api needs the APP_PASSWORD (sent as the x-access-key header by the
 * pages after the login prompt). In production the app refuses to run without one.
 * Buyer-facing invoice links (/i/<token>) and the WhatsApp webhook stay public.
 */
function requireAccess(req: Request, res: Response, next: NextFunction) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    if (isProduction()) return res.status(503).json({ error: "Server is not configured: set APP_PASSWORD." });
    return next();
  }
  const given = String(req.get("x-access-key") ?? "");
  if (given && timingSafeEqual(digest(given), digest(password))) return next();
  res.status(401).json({ error: "Password required", login: true });
}

// Serverless functions have no background timer, so housekeeping (expiring holds,
// waitlist offers, Tally resync) runs at most every 30s, piggybacking on requests.
let lastSweep = 0;
async function lazySweep(_req: Request, _res: Response, next: NextFunction) {
  if (Date.now() - lastSweep > settings.sweepIntervalMs) {
    lastSweep = Date.now();
    try {
      await sweep();
    } catch (err) {
      console.error("[sweep]", err);
    }
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(ROOT, "public")));

  app.get("/", (_req, res) => res.redirect("/demo.html"));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api", requireAccess);
  app.use(["/api/owner", "/api/sim"], lazySweep);

  app.get("/api/status", async (_req, res) => {
    const p = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM approvals WHERE status='pending'");
    const a = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM alerts WHERE NOT resolved");
    res.json({
      business: loadBusiness().name,
      aiMode: assistant().mode,
      erp: erp.name,
      whatsapp: whatsappEnabled(),
      pendingApprovals: p!.c,
      openAlerts: a!.c,
      canReset: !isProduction() || process.env.ALLOW_DEMO_RESET === "true",
      holdHours: { draft: settings.draftHoldMs / 3_600_000, quoted: settings.quotedHoldMs / 3_600_000 },
    });
  });

  // ---------- buyer simulator (stands in for WhatsApp / Instagram / email) ----------

  app.post("/api/sim/message", async (req, res) => {
    const { handle, name, text } = req.body ?? {};
    if (typeof handle !== "string" || !handle.trim() || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "handle and text are required" });
    }
    const messages = await handleInbound({ channel: "simulator", handle: handle.trim().slice(0, 64), name: name ? String(name).slice(0, 80) : null, text: text.slice(0, 4000) });
    res.json({ messages });
  });

  app.get("/api/sim/conversation", async (req, res) => {
    const buyer = await findBuyer("simulator", String(req.query.handle ?? ""));
    if (!buyer) return res.json({ buyer: null, messages: [], order: null });
    const order = await activeOrder(buyer.id);
    res.json({ buyer, messages: await conversation(buyer.id), order: order && { id: order.id, state: order.state } });
  });

  // ---------- owner dashboard ----------

  app.get("/api/owner/approvals", async (req, res) => {
    const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status : null;
    const rows = await Promise.all((await listApprovals(status)).map(async (a) => {
      const invoiceId = a.payload.invoiceId as number | undefined;
      const invoice = invoiceId ? await getInvoice(invoiceId) : null;
      return {
        ...a,
        invoice: invoice && { id: invoice.id, number: invoice.number, status: invoice.status, token: invoice.public_token, breakdown: invoice.payload.breakdown },
      };
    }));
    res.json(rows);
  });

  app.post("/api/owner/approvals/:id/approve", async (req, res) => {
    res.json(await ownerApprove(Number(req.params.id), req.body?.text ?? null));
  });

  app.post("/api/owner/approvals/:id/reject", async (req, res) => {
    const note = String(req.body?.note ?? "").slice(0, 1000);
    const raw = req.body?.extraDiscountPct;
    const extra = raw === undefined || raw === null || raw === "" ? null : Number(raw);
    if (extra !== null && !Number.isFinite(extra)) return res.status(400).json({ error: "extraDiscountPct must be a number" });
    await ownerReject(Number(req.params.id), note, extra);
    res.json({ ok: true });
  });

  app.post("/api/owner/approvals/:id/discount", async (req, res) => {
    const pct = Number(String(req.body?.pct ?? "").replace("%", "").trim());
    if (!Number.isFinite(pct)) return res.status(400).json({ error: "Enter the discount as a number, e.g. 5 for 5%" });
    const next = await ownerSetDiscount(Number(req.params.id), pct);
    res.json({ ok: true, approvalId: next.id });
  });

  // Owner edits numbers on a pending quote/bill: unit prices, extra discount %, remove all discounts.
  app.post("/api/owner/approvals/:id/pricing", async (req, res) => {
    const body = req.body ?? {};
    const num = (v: unknown, label: string): number | null => {
      if (v === undefined || v === null || v === "") return null;
      const n = Number(String(v).replace(/[₹,%\s]/g, ""));
      if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
      return n;
    };
    const changes: PricingChanges = {};
    if (body.prices && typeof body.prices === "object") {
      changes.prices = Object.fromEntries(Object.entries(body.prices as Record<string, unknown>).map(([sku, v]) => [sku, num(v, "Price")]));
    }
    if ("extraDiscountPct" in body) changes.extraDiscountPct = num(body.extraDiscountPct, "Discount") ?? 0;
    if ("negotiatedPct" in body) changes.negotiatedPct = num(body.negotiatedPct, "Special price %") ?? 0;
    if (typeof body.waiveDiscounts === "boolean") changes.waiveDiscounts = body.waiveDiscounts;
    const next = await ownerUpdatePricing(Number(req.params.id), changes);
    res.json({ ok: true, approvalId: next.id });
  });

  // ---------- dispatch / transport ----------

  app.get("/api/owner/dispatch", async (_req, res) => {
    const rows = await all(
      `SELECT o.id, o.state, o.lines, o.delivery, o.dispatch, o.invoice_id, o.updated_at, b.name AS buyer_name, b.handle AS buyer_handle, b.business_name,
              i.number AS invoice_number, i.public_token AS invoice_token
       FROM orders o JOIN buyers b ON b.id=o.buyer_id LEFT JOIN invoices i ON i.id=o.invoice_id
       WHERE o.state IN ('CLOSED','DISPATCHED','DELIVERED') ORDER BY o.updated_at DESC LIMIT 200`,
    );
    res.json(rows);
  });

  app.post("/api/owner/orders/:id/dispatch", async (req, res) => {
    const b = req.body ?? {};
    const order = await ownerDispatch(Number(req.params.id), {
      transporter: String(b.transporter ?? ""), vehicleNo: String(b.vehicleNo ?? ""), lrNo: b.lrNo, ewayBillNo: b.ewayBillNo,
      driverName: b.driverName, driverPhone: b.driverPhone, expectedDelivery: b.expectedDelivery, notes: b.notes,
    });
    res.json({ ok: true, dispatch: order.dispatch });
  });

  app.post("/api/owner/orders/:id/delivered", async (req, res) => {
    await ownerMarkDelivered(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get("/api/owner/inventory", async (_req, res) => res.json(await inventorySnapshot()));

  app.post("/api/owner/erp/adjust", async (req, res) => {
    const { sku, delta } = req.body ?? {};
    const d = Number(delta);
    if (typeof sku !== "string" || !Number.isInteger(d) || d === 0) return res.status(400).json({ error: "sku and a non-zero integer delta are required" });
    const closing = await erp.adjustStock(sku, d);
    await audit("owner", "tally_adjust", `sku:${sku}`, { delta: d, closing });
    const result = await sweep();
    res.json({ closing, ...result });
  });

  app.post("/api/owner/sync", async (_req, res) => res.json(await sweep()));

  app.get("/api/owner/orders", async (_req, res) => {
    res.json((await listOrders()).map((o) => ({
      id: o.id, state: o.state, origin: o.origin, buyer: o.buyer_name ?? o.buyer_handle, lines: o.lines,
      total: o.quote?.breakdown?.totals.grandTotal ?? null, updated_at: o.updated_at, created_at: o.created_at,
      vehicle: o.dispatch?.vehicleNo ?? null,
    })));
  });

  app.get("/api/owner/orders/:id", async (req, res) => {
    const order = await getOrder(Number(req.params.id));
    const buyer = await getBuyer(order.buyer_id);
    const invoice = order.invoice_id ? await getInvoice(order.invoice_id) : null;
    res.json({
      order,
      buyer,
      reservations: await reservationsFor(order.id),
      waitlist: await waitlistForOrder(order.id),
      approvals: await approvalsForOrder(order.id),
      messages: (await conversation(buyer.id)).filter((m) => m.order_id === order.id),
      invoice: invoice && { id: invoice.id, number: invoice.number, token: invoice.public_token, status: invoice.status },
    });
  });

  app.get("/api/owner/buyers", async (_req, res) => {
    const buyers = await all<Buyer & { closed_orders: number }>(
      "SELECT b.*, (SELECT COUNT(*)::int FROM orders o WHERE o.buyer_id=b.id AND o.state='CLOSED') AS closed_orders FROM buyers b ORDER BY b.id DESC",
    );
    res.json(await Promise.all(buyers.map(async (b) => {
      const a = await defaultAddress(b.id);
      return { ...b, address: a ? formatAddress(a) : null };
    })));
  });

  app.get("/api/owner/alerts", async (_req, res) => {
    res.json(await all("SELECT * FROM alerts ORDER BY resolved, id DESC LIMIT 200"));
  });

  app.post("/api/owner/alerts/:id/resolve", async (req, res) => {
    await run("UPDATE alerts SET resolved=TRUE WHERE id=$1", Number(req.params.id));
    res.json({ ok: true });
  });

  app.get("/api/owner/audit", async (_req, res) => {
    res.json(await all("SELECT * FROM audit ORDER BY id DESC LIMIT 300"));
  });

  app.post("/api/dev/reset", async (_req, res) => {
    if (isProduction() && process.env.ALLOW_DEMO_RESET !== "true") return res.status(403).json({ error: "Reset is disabled on this deployment" });
    await wipeAll();
    await seedIfEmpty();
    res.json({ ok: true });
  });

  // ---------- invoices (public link sent to the buyer) ----------

  app.get("/i/:token", async (req, res) => {
    const inv = await getInvoiceByToken(String(req.params.token));
    if (!inv) return res.status(404).send("Invoice not found");
    const order = await getOrder(inv.order_id);
    res.set("Cache-Control", "no-store").type("html").send(renderInvoiceHtml(inv, order.dispatch));
  });

  // ---------- WhatsApp Cloud API webhook ----------

  app.get("/webhooks/whatsapp", (req, res) => {
    const ok = req.query["hub.mode"] === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN && req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN;
    if (ok) res.send(String(req.query["hub.challenge"] ?? ""));
    else res.sendStatus(403);
  });

  app.post("/webhooks/whatsapp", async (req, res) => {
    // Processed before replying: serverless functions may stop once the response is sent.
    // Meta retries slow deliveries; duplicates are ignored by message id.
    for (const m of parseWebhook(req.body)) {
      try {
        await handleInbound({ channel: "whatsapp", handle: m.handle, name: m.name, text: m.text, externalId: m.externalId });
      } catch (err) {
        console.error("[whatsapp] failed to handle message:", err);
      }
    }
    res.sendStatus(200);
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api]", err.message);
    res.status(400).json({ error: err.message });
  });

  return app;
}
