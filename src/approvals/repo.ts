import { all, json, one, run } from "../db.ts";
import { now } from "../clock.ts";
import { audit } from "../audit.ts";

export type Gate = "quote" | "bill";

export interface Approval {
  id: number;
  order_id: number;
  gate: Gate;
  status: "pending" | "approved" | "rejected" | "superseded";
  draft_text: string;
  sent_text: string | null;
  payload: Record<string, unknown>;
  owner_note: string | null;
  attempt: number;
  created_at: number;
  decided_at: number | null;
}

function row(r: Record<string, unknown>): Approval {
  return { ...(r as unknown as Approval), payload: json.parse(r.payload, {}) };
}

export async function createApproval(
  orderId: number, gate: Gate, draftText: string, payload: Record<string, unknown>, ownerNote: string | null,
): Promise<Approval> {
  const prev = await one<{ a: number | null }>("SELECT MAX(attempt) AS a FROM approvals WHERE order_id=$1 AND gate=$2", orderId, gate);
  await run("UPDATE approvals SET status='superseded', decided_at=$1 WHERE order_id=$2 AND status='pending'", now(), orderId);
  const r = await one(
    "INSERT INTO approvals (order_id, gate, status, draft_text, payload, owner_note, attempt, created_at) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7) RETURNING *",
    orderId, gate, draftText, JSON.stringify(payload), ownerNote, (prev?.a ?? 0) + 1, now(),
  );
  await audit("ai", `draft_${gate}`, `order:${orderId}`, { approval: r!.id });
  return row(r!);
}

export async function getApproval(id: number): Promise<Approval> {
  const r = await one("SELECT * FROM approvals WHERE id=$1", id);
  if (!r) throw new Error(`Unknown approval ${id}`);
  return row(r);
}

/** Decide a pending approval. Returns false if it was no longer pending (someone else decided first). */
export async function decide(
  id: number, status: "approved" | "rejected" | "superseded", fields: { sentText?: string; note?: string } = {},
): Promise<boolean> {
  const r = await one(
    `UPDATE approvals SET status=$1, sent_text=COALESCE($2, sent_text), owner_note=COALESCE($3, owner_note), decided_at=$4
     WHERE id=$5 AND status='pending' RETURNING id`,
    status, fields.sentText ?? null, fields.note ?? null, now(), id,
  );
  if (r) await audit("owner", `approval_${status}`, `approval:${id}`, fields.note ? { note: fields.note } : undefined);
  return Boolean(r);
}

export async function listApprovals(
  status: string | null,
): Promise<(Approval & {
  buyer_name: string | null; buyer_handle: string; order_state: string; extra_discount_pct: number;
  price_overrides: Record<string, number>; waive_discounts: boolean; negotiated_pct: number;
})[]> {
  const rows = await all(
    `SELECT a.*, b.name AS buyer_name, b.handle AS buyer_handle, o.state AS order_state, o.extra_discount_pct,
            o.price_overrides, o.waive_discounts, o.negotiation
     FROM approvals a JOIN orders o ON o.id=a.order_id JOIN buyers b ON b.id=o.buyer_id
     WHERE ($1::text IS NULL OR a.status = $1::text) ORDER BY a.id DESC LIMIT 200`,
    status,
  );
  return rows.map((r) => ({
    ...row(r),
    buyer_name: r.buyer_name as string | null,
    buyer_handle: r.buyer_handle as string,
    order_state: r.order_state as string,
    extra_discount_pct: r.extra_discount_pct as number,
    price_overrides: json.parse<Record<string, number>>(r.price_overrides, {}),
    waive_discounts: Boolean(r.waive_discounts),
    negotiated_pct: json.parse<{ pct?: number } | null>(r.negotiation, null)?.pct ?? 0,
  }));
}

export async function approvalsForOrder(orderId: number): Promise<Approval[]> {
  return (await all("SELECT * FROM approvals WHERE order_id=$1 ORDER BY id", orderId)).map(row);
}
