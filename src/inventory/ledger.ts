/**
 * Inventory ledger: the fix for "two or three DMs ask for the same product at once".
 *
 * Tally only knows physical stock and finalized bills. Quotes that are out with
 * buyers are promises Tally knows nothing about. So every conversation reads
 * Available-To-Promise instead of raw stock:
 *
 *   ATP = on_hand (synced from ERP) - committed - live holds
 *
 * and takes stock with reserve(), which locks the product row (SELECT ... FOR UPDATE)
 * inside a transaction. Concurrent requests for the same SKU, from any number of
 * server instances, queue on that lock, so reservations can never exceed on_hand.
 *
 * Reservation lifecycle:
 *   DRAFT_HOLD  (quote drafted, waiting for owner)          expires after draftHoldMs
 *   QUOTED_HOLD (owner approved, quote sent to buyer)       expires after quotedHoldMs
 *   COMMITTED   (buyer accepted)                            no expiry
 *   BILLED      (invoice approved, ERP stock decremented)   no longer counted
 *   RELEASED    (expired / rejected / cancelled / changed)  no longer counted
 *
 * A hold past its expires_at stops counting immediately, even before the sweeper
 * marks it RELEASED, so stale holds never block other buyers.
 */
import { all, one, run, tx } from "../db.ts";
import { now } from "../clock.ts";
import { audit } from "../audit.ts";

export type ReservationState = "DRAFT_HOLD" | "QUOTED_HOLD" | "COMMITTED" | "BILLED" | "RELEASED";

export interface Reservation {
  id: number;
  order_id: number;
  sku: string;
  qty: number;
  state: ReservationState;
  expires_at: number | null;
  release_reason: string | null;
}

export function isLive(r: Reservation, at = now()): boolean {
  if (r.state === "COMMITTED") return true;
  if (r.state === "DRAFT_HOLD" || r.state === "QUOTED_HOLD") return r.expires_at === null || r.expires_at > at;
  return false;
}

/** Locks the product row until the surrounding transaction ends. Must be called inside tx(). */
async function lockSku(sku: string): Promise<number> {
  const row = await one<{ on_hand: number }>("SELECT on_hand FROM products WHERE sku = $1 FOR UPDATE", sku);
  if (!row) throw new Error(`Unknown SKU ${sku}`);
  return row.on_hand;
}

export async function onHand(sku: string): Promise<number> {
  const row = await one<{ on_hand: number }>("SELECT on_hand FROM products WHERE sku = $1", sku);
  if (!row) throw new Error(`Unknown SKU ${sku}`);
  return row.on_hand;
}

/** Units promised (held or committed) for a SKU, optionally ignoring one order's own rows. */
export async function promised(sku: string, excludeOrderId: number | null = null): Promise<number> {
  const row = await one<{ q: number }>(
    `SELECT COALESCE(SUM(qty), 0)::int AS q FROM reservations
     WHERE sku = $1
       AND (state = 'COMMITTED' OR (state IN ('DRAFT_HOLD','QUOTED_HOLD') AND (expires_at IS NULL OR expires_at > $2)))
       AND ($3::int IS NULL OR order_id <> $3::int)`,
    sku, now(), excludeOrderId,
  );
  return row!.q;
}

export async function atp(sku: string, excludeOrderId: number | null = null): Promise<number> {
  return Math.max(0, (await onHand(sku)) - (await promised(sku, excludeOrderId)));
}

export interface ReserveResult {
  sku: string;
  requested: number;
  reserved: number;
  shortfall: number;
  atpBefore: number;
}

/**
 * Atomically hold up to `requested` units of `sku` for an order.
 * Idempotent per (order, sku): calling it again re-sizes that order's single hold
 * instead of stacking a second one (safe for retries and duplicate webhooks).
 * Reserves what is available (partial) and reports the shortfall.
 */
export async function reserve(
  orderId: number,
  sku: string,
  requested: number,
  ttlMs: number,
  state: "DRAFT_HOLD" | "QUOTED_HOLD" = "DRAFT_HOLD",
): Promise<ReserveResult> {
  if (!Number.isInteger(requested) || requested <= 0) throw new Error("requested must be a positive integer");
  return tx(async () => {
    const stock = await lockSku(sku);
    const t = now();
    const available = Math.max(0, stock - (await promised(sku, orderId)));
    const qty = Math.min(requested, available);
    const existing = await one<Reservation>("SELECT * FROM reservations WHERE order_id = $1 AND sku = $2", orderId, sku);
    if (existing && existing.state === "BILLED") throw new Error(`Order ${orderId} already billed for ${sku}`);

    if (qty === 0) {
      if (existing && existing.state !== "RELEASED") {
        await run("UPDATE reservations SET state='RELEASED', release_reason='no_stock', updated_at=$1 WHERE id=$2", t, existing.id);
      }
    } else if (existing) {
      await run(
        "UPDATE reservations SET qty=$1, state=$2, expires_at=$3, release_reason=NULL, updated_at=$4 WHERE id=$5",
        qty, state, t + ttlMs, t, existing.id,
      );
    } else {
      await run(
        "INSERT INTO reservations (order_id, sku, qty, state, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        orderId, sku, qty, state, t + ttlMs, t, t,
      );
    }
    const result = { sku, requested, reserved: qty, shortfall: requested - qty, atpBefore: available };
    await audit("ledger", "reserve", `order:${orderId}`, result);
    return result;
  });
}

export async function reservationsFor(orderId: number): Promise<Reservation[]> {
  return all<Reservation>("SELECT * FROM reservations WHERE order_id = $1 ORDER BY id", orderId);
}

export async function liveReservationsFor(orderId: number): Promise<Reservation[]> {
  const t = now();
  return (await reservationsFor(orderId)).filter((r) => isLive(r, t));
}

/**
 * Move an order's holds to a new state/expiry. A hold that already lapsed is
 * re-acquired against current ATP (it may come back smaller if someone else took
 * the stock meanwhile). Returns what the order holds afterwards.
 */
export async function moveHolds(
  orderId: number,
  to: "QUOTED_HOLD" | "COMMITTED",
  ttlMs: number | null,
): Promise<{ sku: string; wanted: number; held: number }[]> {
  return tx(async () => {
    const rows = (await reservationsFor(orderId)).filter((r) => r.state !== "RELEASED" && r.state !== "BILLED");
    // Lock in a fixed order so two orders sharing SKUs can never deadlock.
    const stock = new Map<string, number>();
    for (const sku of [...new Set(rows.map((r) => r.sku))].sort()) stock.set(sku, await lockSku(sku));
    const t = now();
    const out: { sku: string; wanted: number; held: number }[] = [];
    for (const r of rows) {
      let qty = r.qty;
      if (!isLive(r, t)) qty = Math.min(r.qty, Math.max(0, stock.get(r.sku)! - (await promised(r.sku, orderId))));
      if (qty === 0) {
        await run("UPDATE reservations SET state='RELEASED', release_reason='lapsed', updated_at=$1 WHERE id=$2", t, r.id);
      } else {
        await run(
          "UPDATE reservations SET qty=$1, state=$2, expires_at=$3, updated_at=$4 WHERE id=$5",
          qty, to, ttlMs === null ? null : t + ttlMs, t, r.id,
        );
      }
      out.push({ sku: r.sku, wanted: r.qty, held: qty });
    }
    await audit("ledger", `move:${to}`, `order:${orderId}`, out);
    return out;
  });
}

export async function releaseOrder(orderId: number, reason: string): Promise<Reservation[]> {
  const rows = await all<Reservation>(
    `UPDATE reservations SET state='RELEASED', release_reason=$1, updated_at=$2
     WHERE order_id=$3 AND state NOT IN ('RELEASED','BILLED') RETURNING *`,
    reason, now(), orderId,
  );
  if (rows.length) await audit("ledger", "release", `order:${orderId}`, { reason, skus: rows.map((r) => r.sku) });
  return rows;
}

/** Release this order's holds on every SKU not in `keep` (buyer dropped an item). */
export async function releaseExcept(orderId: number, keep: string[], reason = "item_removed"): Promise<void> {
  await run(
    `UPDATE reservations SET state='RELEASED', release_reason=$1, updated_at=$2
     WHERE order_id=$3 AND state NOT IN ('RELEASED','BILLED') AND NOT (sku = ANY($4::text[]))`,
    reason, now(), orderId, keep,
  );
}

export async function markBilled(orderId: number): Promise<void> {
  await run(
    "UPDATE reservations SET state='BILLED', expires_at=NULL, updated_at=$1 WHERE order_id=$2 AND state='COMMITTED'",
    now(), orderId,
  );
}

/** Mark lapsed holds RELEASED. Returns them so callers can notify buyers and offer the stock onward. */
export async function sweepExpired(): Promise<Reservation[]> {
  const t = now();
  // One statement: if two instances sweep at once, each row is claimed by exactly one.
  const rows = await all<Reservation>(
    `UPDATE reservations SET state='RELEASED', release_reason='expired', updated_at=$1
     WHERE state IN ('DRAFT_HOLD','QUOTED_HOLD') AND expires_at IS NOT NULL AND expires_at <= $1 RETURNING *`,
    t,
  );
  if (rows.length) await audit("ledger", "expire", null, rows.map((r) => ({ order: r.order_id, sku: r.sku, qty: r.qty })));
  return rows;
}

// ---------- Waitlist (buyers who asked for more than was available) ----------

export interface WaitlistEntry {
  id: number;
  buyer_id: number;
  order_id: number;
  sku: string;
  qty: number;
  status: "waiting" | "offered" | "cancelled";
  created_at: number;
}

/** Keep one waiting entry per (order, sku) with the current shortfall; qty 0 removes it. */
export async function setWaitlist(buyerId: number, orderId: number, sku: string, qty: number): Promise<void> {
  const t = now();
  const existing = await one<{ id: number }>("SELECT id FROM waitlist WHERE order_id=$1 AND sku=$2 AND status='waiting'", orderId, sku);
  if (qty <= 0) {
    if (existing) await run("UPDATE waitlist SET status='cancelled', updated_at=$1 WHERE id=$2", t, existing.id);
  } else if (existing) {
    await run("UPDATE waitlist SET qty=$1, updated_at=$2 WHERE id=$3", qty, t, existing.id);
  } else {
    await run(
      "INSERT INTO waitlist (buyer_id, order_id, sku, qty, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'waiting',$5,$6)",
      buyerId, orderId, sku, qty, t, t,
    );
  }
}

export async function cancelWaitlistForOrder(orderId: number): Promise<void> {
  await run("UPDATE waitlist SET status='cancelled', updated_at=$1 WHERE order_id=$2 AND status='waiting'", now(), orderId);
}

/** First-come-first-served queue for a SKU. */
export async function waitingFor(sku: string): Promise<WaitlistEntry[]> {
  return all<WaitlistEntry>("SELECT * FROM waitlist WHERE sku=$1 AND status='waiting' ORDER BY created_at, id", sku);
}

export async function waitlistForOrder(orderId: number): Promise<WaitlistEntry[]> {
  return all<WaitlistEntry>("SELECT * FROM waitlist WHERE order_id=$1 AND status='waiting' ORDER BY id", orderId);
}

/** Claim an entry for offering. False if another instance already claimed it. */
export async function claimWaitlist(id: number): Promise<boolean> {
  return Boolean(await one("UPDATE waitlist SET status='offered', updated_at=$1 WHERE id=$2 AND status='waiting' RETURNING id", now(), id));
}

// ---------- Reporting ----------

export interface StockRow {
  sku: string;
  name: string;
  on_hand: number;
  draft_held: number;
  quoted_held: number;
  committed: number;
  atp: number;
  waitlisted: number;
  synced_at: number;
}

export async function inventorySnapshot(): Promise<StockRow[]> {
  const rows = await all<StockRow>(
    `SELECT p.sku, p.name, p.on_hand, p.synced_at,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.sku=p.sku AND r.state='DRAFT_HOLD' AND r.expires_at > $1),0)::int AS draft_held,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.sku=p.sku AND r.state='QUOTED_HOLD' AND r.expires_at > $1),0)::int AS quoted_held,
      COALESCE((SELECT SUM(qty) FROM reservations r WHERE r.sku=p.sku AND r.state='COMMITTED'),0)::int AS committed,
      COALESCE((SELECT SUM(qty) FROM waitlist w WHERE w.sku=p.sku AND w.status='waiting'),0)::int AS waitlisted
     FROM products p ORDER BY p.category, p.name`,
    now(),
  );
  return rows.map((row) => ({ ...row, atp: Math.max(0, row.on_hand - row.draft_held - row.quoted_held - row.committed) }));
}

/** SKUs where promises exceed physical stock (e.g. a walk-in sale was billed straight in Tally). */
export async function oversold(): Promise<{ sku: string; over: number }[]> {
  return (await inventorySnapshot())
    .map((s) => ({ sku: s.sku, over: s.draft_held + s.quoted_held + s.committed - s.on_hand }))
    .filter((s) => s.over > 0);
}
