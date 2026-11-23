/**
 * Outbound messages go through sendToBuyer(), which enforces the approval gates:
 * a quote or an invoice can only leave if an owner-approved approval exists for it.
 */
import { one } from "../db.ts";
import { now } from "../clock.ts";
import { audit, raiseAlert } from "../audit.ts";
import type { Buyer, MessageRow } from "../orders/repo.ts";
import { whatsapp } from "./whatsapp.ts";

/** "dispatch" messages are sent by the owner's own action (entering the vehicle details), so they need no separate approval. */
export type OutboundKind = "chat" | "ack" | "quote" | "invoice" | "dispatch";

const GATED: Record<string, "quote" | "bill"> = { quote: "quote", invoice: "bill" };

export interface Channel {
  readonly name: string;
  deliver(handle: string, text: string): Promise<void>;
}

const simulator: Channel = {
  name: "simulator",
  async deliver() {
    // Stored in the messages table; the simulator page polls it.
  },
};

const channels: Record<string, Channel> = { simulator, whatsapp };

export class ApprovalRequiredError extends Error {}

export async function sendToBuyer(args: {
  buyer: Buyer; orderId: number | null; text: string; kind: OutboundKind; approvalId?: number;
}): Promise<MessageRow> {
  const { buyer, orderId, text, kind, approvalId } = args;
  const gate = GATED[kind];
  if (gate) {
    const a = approvalId
      ? await one<{ status: string; gate: string; order_id: number }>("SELECT status, gate, order_id FROM approvals WHERE id=$1", approvalId)
      : undefined;
    if (!a || a.status !== "approved" || a.gate !== gate || a.order_id !== orderId) {
      await audit("system", "blocked_send", `order:${orderId}`, { kind, approvalId });
      throw new ApprovalRequiredError(`A ${kind} cannot be sent to the buyer without the owner's approval`);
    }
  }
  const row = (await one<MessageRow>(
    "INSERT INTO messages (buyer_id, order_id, direction, kind, text, approval_id, created_at) VALUES ($1, $2, 'out', $3, $4, $5, $6) RETURNING *",
    buyer.id, orderId, kind, text, approvalId ?? null, now(),
  ))!;

  const channel = channels[buyer.channel] ?? simulator;
  try {
    // Awaited: on serverless hosting, work left running after the response may be cut off.
    await channel.deliver(buyer.handle, text);
  } catch (err) {
    console.error(`[${channel.name}] delivery failed:`, (err as Error).message);
    await raiseAlert("delivery_failed", `Could not deliver a message to ${buyer.name ?? buyer.handle} on ${channel.name}: ${(err as Error).message}`, `order:${orderId}`);
  }
  return row;
}
