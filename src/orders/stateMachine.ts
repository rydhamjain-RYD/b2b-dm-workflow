/**
 * The order flow is enforced here, in code. The AI cannot skip a step or an approval:
 * the only way to move an order is through transition(), which rejects anything
 * not listed below.
 *
 *  AWAITING_REQUIREMENT -> QUOTE_PENDING_APPROVAL ==(owner gate 1)==> AWAITING_BUYER_CONFIRMATION
 *    -> AWAITING_DELIVERY -> BILL_PENDING_APPROVAL ==(owner gate 2)==> CLOSED (billed)
 *    -> DISPATCHED (owner enters vehicle / transporter) -> DELIVERED
 *  side states: WAITLISTED, EXPIRED, CANCELLED
 */
export const ORDER_STATES = [
  "AWAITING_REQUIREMENT",
  "QUOTE_PENDING_APPROVAL",
  "AWAITING_BUYER_CONFIRMATION",
  "AWAITING_DELIVERY",
  "BILL_PENDING_APPROVAL",
  "CLOSED",
  "DISPATCHED",
  "DELIVERED",
  "WAITLISTED",
  "EXPIRED",
  "CANCELLED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  AWAITING_REQUIREMENT: ["QUOTE_PENDING_APPROVAL", "CANCELLED"],
  QUOTE_PENDING_APPROVAL: ["QUOTE_PENDING_APPROVAL", "AWAITING_BUYER_CONFIRMATION", "WAITLISTED", "CANCELLED"],
  AWAITING_BUYER_CONFIRMATION: ["AWAITING_DELIVERY", "QUOTE_PENDING_APPROVAL", "EXPIRED", "CANCELLED"],
  AWAITING_DELIVERY: ["BILL_PENDING_APPROVAL", "CANCELLED"],
  BILL_PENDING_APPROVAL: ["BILL_PENDING_APPROVAL", "CLOSED", "CANCELLED"],
  WAITLISTED: ["QUOTE_PENDING_APPROVAL", "CANCELLED"],
  EXPIRED: ["QUOTE_PENDING_APPROVAL", "CANCELLED"],
  // CLOSED = billed. The owner then records the vehicle/transporter (DISPATCHED) and delivery.
  CLOSED: ["DISPATCHED"],
  DISPATCHED: ["DISPATCHED", "DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

/** States in which buyer messages no longer belong to the order (a new DM starts a new order). */
export const FINISHED: OrderState[] = ["CLOSED", "DISPATCHED", "DELIVERED", "CANCELLED"];

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new Error(`Illegal order transition ${from} -> ${to}`);
}
