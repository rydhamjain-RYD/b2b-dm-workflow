/**
 * What the assistant is allowed to do: understand buyer text and write wording.
 * It never decides stock, prices, totals or which step comes next; code does that.
 */
export type Intent =
  | "greeting"      // "Hi, we have a requirement"
  | "requirement"   // names products / quantities
  | "accept"        // agrees to the quote / "yes, same address"
  | "decline"       // not interested / cancel
  | "negotiate"     // "too costly", "best price?", "can you do 1700", "competitor gives 5% less"
  | "delivery"      // gives delivery details
  | "question"      // asks something the bot should not answer on its own
  | "other";

export interface RequestedItem {
  productText: string;
  brand: string | null;
  qty: number | null;
}

export interface DeliveryInfo {
  businessName: string | null;
  gstin: string | null;
  contactName: string | null;
  phone: string | null;
  line: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}

/** What the buyer asked for when bargaining, if they named a number. */
export interface NegotiationAsk {
  askUnitPrice: number | null;
  askPct: number | null;
}

export interface Understanding {
  intent: Intent;
  items: RequestedItem[];
  delivery: DeliveryInfo | null;
  question: string | null;
  negotiation?: NegotiationAsk | null;
}

export interface UnderstandContext {
  /** Current order state, so "yes" can be read correctly. */
  state: string;
  lastBotMessage: string | null;
  productNames: string[];
}

export interface WordingContext {
  businessName: string;
  buyerName: string | null;
  tone: string;
  situation: "quote" | "quote_partial" | "quote_unavailable" | "quote_restocked" | "bill" | "counter_offer" | "final_offer";
  /** For counter offers: 1 = first concession, 2 = second, ... */
  negotiationRound?: number;
  /** For counter offers: what the buyer wrote. */
  buyerMessage?: string | null;
  /** Owner's feedback when they rejected the previous draft. */
  ownerNote: string | null;
  previousDraft: string | null;
}

export interface Wording {
  intro: string;
  closing: string;
}

export interface Assistant {
  readonly mode: "claude" | "rules";
  understand(text: string, ctx: UnderstandContext): Promise<Understanding>;
  /** Text that goes around the engine-generated numbers block. Must not contain numbers. */
  wording(ctx: WordingContext): Promise<Wording>;
}

export const EMPTY_DELIVERY: DeliveryInfo = {
  businessName: null, gstin: null, contactName: null, phone: null, line: null, city: null, state: null, pincode: null,
};
