import { all, json, one, run } from "../db.ts";
import { now } from "../clock.ts";
import type { OrderState } from "./stateMachine.ts";
import { assertTransition, FINISHED } from "./stateMachine.ts";
import type { PriceBreakdown } from "../pricing/engine.ts";
import type { DeliveryInfo } from "../ai/types.ts";
import { audit } from "../audit.ts";

export interface Buyer {
  id: number;
  channel: string;
  handle: string;
  name: string | null;
  business_name: string | null;
  gstin: string | null;
}

export interface Address {
  id: number;
  buyer_id: number;
  contact_name: string | null;
  phone: string | null;
  line: string;
  city: string | null;
  state: string;
  pincode: string;
}

export interface OrderLine {
  sku: string;
  name: string;
  requested: number;
}

/** An item the buyer mentioned that is not resolved yet (needs brand or quantity). */
export interface PendingItem {
  productText: string;
  qty: number | null;
  sku: string | null;
  candidates: string[];
}

export interface QuoteLine {
  sku: string;
  name: string;
  unit: string;
  requested: number;
  offered: number;
  shortfall: number;
}

export interface Quote {
  version: number;
  createdAt: number;
  situation: string;
  lines: QuoteLine[];
  breakdown: PriceBreakdown | null;
  block: string;
}

/** Delivery details collected so far; gstinInvalid holds what the buyer typed if it failed validation. */
export type DeliveryDraft = Partial<DeliveryInfo> & { gstinInvalid?: string | null };

export interface Order {
  id: number;
  buyer_id: number;
  channel: string;
  state: OrderState;
  origin: string;
  lines: OrderLine[];
  pending: PendingItem[];
  quote: Quote | null;
  quote_version: number;
  extra_discount_pct: number;
  delivery: DeliveryDraft | null;
  invoice_id: number | null;
  /** Unit prices the owner typed, by SKU. */
  price_overrides: Record<string, number>;
  waive_discounts: boolean;
  negotiation: Negotiation | null;
  dispatch: Dispatch | null;
  created_at: number;
  updated_at: number;
}

export interface NegotiationRound {
  at: number;
  buyerText: string;
  askUnitPrice: number | null;
  askPct: number | null;
  offeredPct: number;
  final: boolean;
}

export interface Negotiation {
  /** Special price currently on the quote, % off the bill. */
  pct: number;
  rounds: NegotiationRound[];
}

export interface Dispatch {
  transporter: string;
  vehicleNo: string;
  lrNo: string | null;
  ewayBillNo: string | null;
  driverName: string | null;
  driverPhone: string | null;
  expectedDelivery: string | null;
  notes: string | null;
  dispatchedAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

function rowToOrder(r: Record<string, unknown>): Order {
  return {
    ...(r as unknown as Order),
    lines: json.parse(r.lines, []),
    pending: json.parse(r.pending, []),
    quote: json.parse(r.quote, null),
    delivery: json.parse(r.delivery, null),
    price_overrides: json.parse(r.price_overrides, {}),
    waive_discounts: Boolean(r.waive_discounts),
    negotiation: json.parse(r.negotiation, null),
    dispatch: json.parse(r.dispatch, null),
  };
}

export async function upsertBuyer(channel: string, handle: string, name: string | null): Promise<Buyer> {
  return (await one<Buyer>(
    `INSERT INTO buyers (channel, handle, name, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel, handle) DO UPDATE SET name = COALESCE(buyers.name, EXCLUDED.name)
     RETURNING *`,
    channel, handle, name, now(),
  ))!;
}

export async function findBuyer(channel: string, handle: string): Promise<Buyer | undefined> {
  return one<Buyer>("SELECT * FROM buyers WHERE channel=$1 AND handle=$2", channel, handle);
}

export async function getBuyer(id: number): Promise<Buyer> {
  const b = await one<Buyer>("SELECT * FROM buyers WHERE id=$1", id);
  if (!b) throw new Error(`Unknown buyer ${id}`);
  return b;
}

export async function updateBuyer(id: number, fields: { business_name?: string | null; gstin?: string | null }): Promise<void> {
  if (fields.business_name) await run("UPDATE buyers SET business_name=$1 WHERE id=$2", fields.business_name, id);
  if (fields.gstin) await run("UPDATE buyers SET gstin=$1 WHERE id=$2", fields.gstin, id);
}

export async function defaultAddress(buyerId: number): Promise<Address | null> {
  return (await one<Address>("SELECT * FROM addresses WHERE buyer_id=$1 AND is_default ORDER BY id DESC LIMIT 1", buyerId)) ?? null;
}

export async function saveAddress(buyerId: number, d: DeliveryDraft): Promise<void> {
  const same = await defaultAddress(buyerId);
  if (same && same.line === d.line && same.pincode === d.pincode) return;
  await run("UPDATE addresses SET is_default=FALSE WHERE buyer_id=$1", buyerId);
  await run(
    "INSERT INTO addresses (buyer_id, contact_name, phone, line, city, state, pincode, is_default, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)",
    buyerId, d.contactName ?? null, d.phone ?? null, d.line ?? "", d.city ?? null, d.state ?? "", d.pincode ?? "", now(),
  );
}

/** "12 MG Road, Camp, Pune, Maharashtra 411001" without repeating parts already in the street line. */
export function addressText(a: { line?: string | null; city?: string | null; state?: string | null; pincode?: string | null }): string {
  const line = a.line ?? "";
  const has = (s: string | null | undefined) => Boolean(s) && line.toLowerCase().includes(s!.toLowerCase());
  const tail = [has(a.state) ? null : a.state, has(a.pincode) ? null : a.pincode].filter(Boolean).join(" ");
  return [line || null, has(a.city) ? null : a.city, tail || null].filter(Boolean).join(", ");
}

export function formatAddress(a: Pick<Address, "line" | "city" | "state" | "pincode" | "contact_name" | "phone">): string {
  const contact = [a.contact_name, a.phone].filter(Boolean).join(", ");
  return addressText(a) + (contact ? `\nContact: ${contact}` : "");
}

export async function getOrder(id: number): Promise<Order> {
  const r = await one("SELECT * FROM orders WHERE id=$1", id);
  if (!r) throw new Error(`Unknown order ${id}`);
  return rowToOrder(r);
}

export async function listOrders(limit = 100): Promise<(Order & { buyer_name: string | null; buyer_handle: string })[]> {
  const rows = await all(
    "SELECT o.*, b.name AS buyer_name, b.handle AS buyer_handle FROM orders o JOIN buyers b ON b.id=o.buyer_id ORDER BY o.updated_at DESC, o.id DESC LIMIT $1",
    limit,
  );
  return rows.map((r) => ({ ...rowToOrder(r), buyer_name: r.buyer_name as string | null, buyer_handle: r.buyer_handle as string }));
}

const FINISHED_SQL = FINISHED.map((s) => `'${s}'`).join(",");

/** The order a new buyer message belongs to: the most recently active unfinished one. */
export async function activeOrder(buyerId: number): Promise<Order | null> {
  const r = await one(
    `SELECT * FROM orders WHERE buyer_id=$1 AND state NOT IN (${FINISHED_SQL}) ORDER BY updated_at DESC, id DESC LIMIT 1`,
    buyerId,
  );
  return r ? rowToOrder(r) : null;
}

/** Has this buyer bought from us before? (Negotiation is only automated for new clients.) */
export async function isReturningBuyer(buyerId: number): Promise<boolean> {
  return Boolean(await one("SELECT 1 FROM orders WHERE buyer_id=$1 AND state IN ('CLOSED','DISPATCHED','DELIVERED') LIMIT 1", buyerId));
}

/** Most recent billed order, for "where is my order?" questions. */
export async function latestShippedOrder(buyerId: number): Promise<Order | null> {
  const r = await one(
    "SELECT * FROM orders WHERE buyer_id=$1 AND state IN ('CLOSED','DISPATCHED','DELIVERED') ORDER BY updated_at DESC, id DESC LIMIT 1",
    buyerId,
  );
  return r ? rowToOrder(r) : null;
}

export async function ordersInProgress(buyerId: number): Promise<Order[]> {
  const rows = await all(
    "SELECT * FROM orders WHERE buyer_id=$1 AND state NOT IN ('CLOSED','DISPATCHED','DELIVERED','CANCELLED','WAITLISTED','EXPIRED')",
    buyerId,
  );
  return rows.map(rowToOrder);
}

export async function createOrder(buyer: Buyer, origin = "dm"): Promise<Order> {
  const t = now();
  const r = await one(
    "INSERT INTO orders (buyer_id, channel, state, origin, created_at, updated_at) VALUES ($1, $2, 'AWAITING_REQUIREMENT', $3, $4, $5) RETURNING *",
    buyer.id, buyer.channel, origin, t, t,
  );
  await audit("system", "order_created", `order:${r!.id}`, { origin });
  return rowToOrder(r!);
}

export async function saveOrder(order: Order, patch: Partial<Omit<Order, "id">>): Promise<Order> {
  if (patch.state && patch.state !== order.state) {
    assertTransition(order.state, patch.state);
    await audit("system", "order_state", `order:${order.id}`, { from: order.state, to: patch.state });
  }
  const next: Order = { ...order, ...patch, updated_at: now() };
  const j = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  await run(
    `UPDATE orders SET state=$1, lines=$2, pending=$3, quote=$4, quote_version=$5, extra_discount_pct=$6, delivery=$7, invoice_id=$8,
       price_overrides=$9, waive_discounts=$10, negotiation=$11, dispatch=$12, updated_at=$13 WHERE id=$14`,
    next.state, JSON.stringify(next.lines), JSON.stringify(next.pending), j(next.quote),
    next.quote_version, next.extra_discount_pct, j(next.delivery), next.invoice_id,
    JSON.stringify(next.price_overrides ?? {}), next.waive_discounts, j(next.negotiation), j(next.dispatch),
    next.updated_at, order.id,
  );
  return next;
}

export interface MessageRow {
  id: number;
  buyer_id: number;
  order_id: number | null;
  direction: "in" | "out";
  kind: string;
  text: string;
  approval_id: number | null;
  created_at: number;
}

export async function logInbound(buyerId: number, orderId: number, text: string, externalId: string | null): Promise<MessageRow> {
  return (await one<MessageRow>(
    "INSERT INTO messages (buyer_id, order_id, direction, kind, text, external_id, created_at) VALUES ($1, $2, 'in', 'chat', $3, $4, $5) RETURNING *",
    buyerId, orderId, text, externalId, now(),
  ))!;
}

export async function seenExternal(externalId: string): Promise<boolean> {
  return Boolean(await one("SELECT 1 FROM messages WHERE external_id=$1", externalId));
}

export async function lastOutbound(buyerId: number): Promise<string | null> {
  const r = await one<{ text: string }>("SELECT text FROM messages WHERE buyer_id=$1 AND direction='out' ORDER BY id DESC LIMIT 1", buyerId);
  return r?.text ?? null;
}

export async function conversation(buyerId: number): Promise<MessageRow[]> {
  return all<MessageRow>("SELECT * FROM messages WHERE buyer_id=$1 ORDER BY id", buyerId);
}
