/**
 * Rule-based assistant. Used when no Claude credential is configured, and as the
 * safety net if a Claude call fails. Good enough for clear messages such as
 * "need 500 boAt smartwatches", "yes, go ahead" or a typical address.
 */
import type { Assistant, DeliveryInfo, Understanding, UnderstandContext, Wording, WordingContext, RequestedItem } from "./types.ts";

export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur",
  "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
  "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Delhi", "Jammu and Kashmir", "Ladakh",
  "Chandigarh", "Puducherry", "Andaman and Nicobar Islands", "Dadra and Nagar Haveli and Daman and Diu", "Lakshadweep",
];

/** Common business cities -> state, so "Banerghatta Road, Bangalore" is enough to know the state. */
const CITY_STATE: Record<string, string> = {
  mumbai: "Maharashtra", bombay: "Maharashtra", pune: "Maharashtra", nagpur: "Maharashtra", thane: "Maharashtra",
  "navi mumbai": "Maharashtra", nashik: "Maharashtra", aurangabad: "Maharashtra",
  bangalore: "Karnataka", bengaluru: "Karnataka", banglore: "Karnataka", mysore: "Karnataka", mysuru: "Karnataka", mangalore: "Karnataka", hubli: "Karnataka",
  delhi: "Delhi", "new delhi": "Delhi",
  noida: "Uttar Pradesh", ghaziabad: "Uttar Pradesh", lucknow: "Uttar Pradesh", kanpur: "Uttar Pradesh", agra: "Uttar Pradesh", varanasi: "Uttar Pradesh",
  gurgaon: "Haryana", gurugram: "Haryana", faridabad: "Haryana",
  chennai: "Tamil Nadu", madras: "Tamil Nadu", coimbatore: "Tamil Nadu", madurai: "Tamil Nadu",
  hyderabad: "Telangana", secunderabad: "Telangana",
  kolkata: "West Bengal", calcutta: "West Bengal", howrah: "West Bengal",
  ahmedabad: "Gujarat", surat: "Gujarat", vadodara: "Gujarat", rajkot: "Gujarat",
  jaipur: "Rajasthan", jodhpur: "Rajasthan", udaipur: "Rajasthan",
  indore: "Madhya Pradesh", bhopal: "Madhya Pradesh",
  patna: "Bihar", bhubaneswar: "Odisha", ranchi: "Jharkhand", raipur: "Chhattisgarh",
  kochi: "Kerala", cochin: "Kerala", trivandrum: "Kerala", thiruvananthapuram: "Kerala", kozhikode: "Kerala",
  visakhapatnam: "Andhra Pradesh", vizag: "Andhra Pradesh", vijayawada: "Andhra Pradesh",
  chandigarh: "Chandigarh", ludhiana: "Punjab", amritsar: "Punjab", dehradun: "Uttarakhand", guwahati: "Assam", panaji: "Goa",
};

/** First two digits of a GSTIN are the state code. */
const GST_STATE: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep",
  "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh",
};

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function isValidGstin(g: string | null | undefined): boolean {
  return Boolean(g) && GSTIN_RE.test(g!.toUpperCase());
}

export function stateFromGstin(g: string | null | undefined): string | null {
  return isValidGstin(g) ? GST_STATE[g!.slice(0, 2)] ?? null : null;
}

export function stateFromCity(city: string | null | undefined): string | null {
  return city ? CITY_STATE[city.toLowerCase().trim()] ?? null : null;
}

const ACCEPT = /\b(yes|yeah|yep|yup|ok|okay|confirm(ed)?|agreed?|go ahead|proceed|done|deal|sure|fine|approved?|haan|ha|theek hai|chalega|same address|same as (before|last time))\b/i;
const DECLINE = /\b(no|nope|not interested|cancel|reject(ed)?|nahi|not now|drop it)\b/i;
/** Bargaining, in English and common Hinglish. */
const NEGOTIATE = /\b(too (high|costly|expensive|much)|costly|expensive|best (price|rate)|last (price|rate)|final (price|rate)|discount|reduce|lower (the )?(price|rate)|better (price|rate)|kam karo|kuch kam|thoda kam|rate kam|kam kar|negotiat\w*|bargain|competitor|cheaper|can you do|match (the|their) price|less price|price (is )?high|rate (is )?high|zyada|mehenga|mehnga)\b/i;

/** "can you do 1700", "₹1,650 per piece", "5% discount" */
export function extractAsk(text: string): { askUnitPrice: number | null; askPct: number | null } {
  const pctM = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const priceM =
    text.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i) ??
    text.match(/([\d,]+(?:\.\d+)?)\s*(?:\/-|rs\b|rupees|per\s*(?:piece|pc|pcs|unit|nos|watch|item)|each|\/\s*(?:pc|unit|piece))/i) ??
    text.match(/\b(?:do|at|for|make it|give(?: it)?(?: at| for)?|offer)\s*(?:₹|rs\.?)?\s*([\d,]+(?:\.\d+)?)\b/i);
  const price = priceM ? Number(priceM[1].replace(/,/g, "")) : null;
  return { askUnitPrice: price && price > 0 ? price : null, askPct: pctM ? Number(pctM[1]) : null };
}
const QUESTION = /\?|\b(warranty|delivery time|when can|how long|credit|payment terms?|specs?|specification|colou?r|return policy|catalog(ue)?)\b/i;
const GREETING = /\b(hi|hello|hey|namaste|requirement|enquiry|inquiry|interested|looking for|need|want|require)\b/i;
export const NO_GST = /\b(no gst|without gst|not registered|unregistered|gst not available|don'?t have (a )?gst|skip gst|no gstin)\b/i;

const STOP = new Set([
  "we", "i", "us", "our", "need", "needs", "want", "wants", "require", "required", "requirement", "requirements",
  "have", "has", "a", "an", "the", "of", "for", "please", "pls", "kindly", "send", "quote", "price", "prices", "rate",
  "units", "unit", "pcs", "pc", "pieces", "piece", "nos", "no", "qty", "quantity", "x", "and", "also", "some", "can",
  "you", "supply", "get", "me", "is", "are", "there", "any", "available", "availability", "with", "to", "do", "hi",
  "hello", "sir", "madam", "ji", "about", "around", "approx", "approximately", "like", "would", "order", "buy", "total",
  "change", "make", "it", "instead", "only", "more", "boxes", "box", "lot", "urgently", "urgent", "asap",
]);

function parseQty(raw: string, suffix?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  return suffix && /^k$/i.test(suffix) ? n * 1000 : n;
}

export function extractItems(text: string): RequestedItem[] {
  const items: RequestedItem[] = [];
  const segments = text.split(/[,;\n+]|\band\b|&/i);
  for (const seg of segments) {
    const m = seg.match(/(\d[\d,]*)\s*(k\b)?/i);
    const qty = m ? parseQty(m[1], m[2]) : null;
    const words = seg
      .replace(/(\d[\d,]*)\s*(k\b)?/gi, " ")
      .toLowerCase()
      .replace(/[^a-z0-9\- ]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w));
    if (!words.length) continue;
    if (qty === null && words.length > 6) continue; // long sentence without a number: not a line item
    items.push({ productText: words.join(" "), brand: null, qty: qty && qty > 0 ? qty : null });
  }
  return items;
}

const COMPANY = /\b(pvt|private|ltd|limited|llp|traders?|trading|enterprises?|retail|mobiles?|electronics|stores?|mart|agenc(y|ies)|distributors?|industries|company|corporation|sons|& co|m\/s)\b/i;
const PHONE = /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/;
const PLAIN_NAME = /^[A-Za-z][A-Za-z .']{1,40}$/;

/**
 * Pulls delivery details out of free text, e.g.
 *   "Acme Retail Pvt Ltd, GSTIN 27AAACA1234A1Z5, 12 MG Road, Camp, Pune, Maharashtra 411001, contact: Ravi 9876543210"
 *   "mesa\ngstn dhdiahsdnsd12333n\nbanergatta road, bangalore\nsinchan rai\n8310817359"
 * A GSTIN that was clearly labelled but is malformed is returned as written, so the
 * caller can tell the buyer it looks wrong instead of silently dropping it.
 */
export function extractDelivery(text: string): DeliveryInfo {
  const pincode = text.match(/\b[1-9]\d{5}\b/)?.[0] ?? null;
  const phone = text.match(PHONE)?.[0] ?? null;
  const lower = text.toLowerCase();
  let state = [...INDIAN_STATES].sort((a, b) => b.length - a.length).find((s) => lower.includes(s.toLowerCase())) ?? null;
  let gstin = text.toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/)?.[0] ?? null;
  let contactName = text.match(/(?:contact(?: person)?|attn|name)\s*[:\-]?\s*([A-Za-z][A-Za-z .]{1,39})/i)?.[1]?.trim() ?? null;
  let businessName: string | null = null;
  let city: string | null = null;

  const segs = text.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean);
  const parts: string[] = [];
  segs.forEach((seg, i) => {
    const labelled = seg.match(/^(?:gstin|gstn|gst(?:\s*(?:no\.?|number|in))?)\s*[:\-#]?\s*([A-Za-z0-9]+)\s*$/i);
    if (labelled) {
      if (!gstin) gstin = labelled[1].toUpperCase();
      return;
    }
    if (gstin && seg.toUpperCase().includes(gstin)) return;
    if (/\b(contact|attn)\b/i.test(seg)) return;
    if (phone && seg.includes(phone)) {
      const rest = seg.replace(phone, "").replace(/\b(phone|mobile|mob|ph|tel)\b\s*[:\-]?/gi, "").trim();
      if (!contactName && PLAIN_NAME.test(rest)) contactName = rest;
      return;
    }
    if (/^(phone|mobile|mob)\b/i.test(seg)) return;
    // A short plain name right before the phone number is the contact person ("sinchan rai" / "8310817359").
    const next = segs[i + 1];
    if (!contactName && next && PHONE.test(next) && next.replace(PHONE, "").trim() === "" && PLAIN_NAME.test(seg) && seg.split(/\s+/).length <= 3 && !stateFromCity(seg)) {
      contactName = seg;
      return;
    }
    if (i === 0 && !/\d/.test(seg) && !stateFromCity(seg) && (COMPANY.test(seg) || (segs.length >= 3 && seg.split(/\s+/).length <= 5))) {
      businessName = seg.replace(/^(m\/s\.?|company|business|firm)\s*[:\-]?\s*/i, "");
      return;
    }
    let rest = seg;
    if (state) rest = rest.replace(new RegExp(state, "i"), "");
    if (pincode) rest = rest.replace(pincode, "");
    rest = rest.replace(/^[\s\-–]+|[\s\-–]+$/g, "");
    if (!rest) return;
    if (!city && stateFromCity(rest)) {
      city = rest;
      return;
    }
    parts.push(rest);
  });
  // "…, Camp, Pune, Maharashtra 411001": the last plain word before the state is the city.
  if (!city && state && parts.length > 1 && /^[A-Za-z][A-Za-z .]{1,30}$/.test(parts.at(-1)!)) city = parts.pop()!;
  state = state ?? stateFromCity(city) ?? stateFromGstin(gstin);
  const line = parts.join(", ") || null;
  return { businessName, gstin, contactName, phone, line, city, state, pincode };
}

function hasDeliveryInfo(d: DeliveryInfo): boolean {
  return Boolean(d.pincode || d.state || d.gstin || d.phone || d.city || d.line);
}

/** "Ravi (Acme Retail)" -> "Ravi ji"; no name -> "Sir". */
function ji(name: string | null): string {
  const first = name?.trim().split(/[\s(,]/)[0];
  return first && /^[A-Za-z]/.test(first) ? `${first} ji` : "Sir";
}

export class RulesAssistant implements Assistant {
  readonly mode = "rules" as const;

  async understand(text: string, ctx: UnderstandContext): Promise<Understanding> {
    const items = extractItems(text).filter((i) => i.qty !== null || ctx.state === "AWAITING_REQUIREMENT");
    const base: Understanding = { intent: "other", items: [], delivery: null, question: null };
    const short = text.trim().split(/\s+/).length <= 5;

    if (ctx.state === "AWAITING_DELIVERY") {
      if (short && ACCEPT.test(text) && !/\d/.test(text)) return { ...base, intent: "accept" };
      if (short && DECLINE.test(text) && !NO_GST.test(text)) return { ...base, intent: "decline" };
      if (QUESTION.test(text) && !/\d{6}/.test(text)) return { ...base, intent: "question", question: text };
      const delivery = extractDelivery(text);
      if (hasDeliveryInfo(delivery) || NO_GST.test(text)) return { ...base, intent: "delivery", delivery };
      return { ...base, intent: "other", question: text };
    }

    // After a quote, numbers in a bargaining message are prices, not new quantities.
    if (["AWAITING_BUYER_CONFIRMATION", "QUOTE_PENDING_APPROVAL"].includes(ctx.state) && NEGOTIATE.test(text) && !/not interested|cancel/i.test(text)) {
      return { ...base, intent: "negotiate", negotiation: extractAsk(text) };
    }
    const withQty = items.filter((i) => i.qty !== null);
    if (withQty.length) return { ...base, intent: "requirement", items: withQty };
    if (DECLINE.test(text)) return { ...base, intent: "decline" };
    if (ACCEPT.test(text) && !QUESTION.test(text)) return { ...base, intent: "accept" };
    if (QUESTION.test(text)) return { ...base, intent: "question", question: text };
    if (ctx.state === "AWAITING_REQUIREMENT" && items.length && !GREETING.test(text)) {
      return { ...base, intent: "requirement", items };
    }
    if (GREETING.test(text)) return { ...base, intent: "greeting" };
    return { ...base, intent: "other", question: text };
  }

  async wording(ctx: WordingContext): Promise<Wording> {
    const hi = ctx.buyerName ? `Hello ${ctx.buyerName},` : "Hello,";
    switch (ctx.situation) {
      case "quote":
        return { intro: `${hi} thank you for your enquiry. Good news, we have your requirement ready:`, closing: "Please reply YES to confirm and we will take your delivery details." };
      case "quote_partial":
        return { intro: `${hi} thank you for your enquiry. Here is what we can supply right now:`, closing: "Reply YES to confirm the available quantity. We have added the balance to our priority waitlist and will message you as soon as it is back in stock." };
      case "quote_unavailable":
        return { intro: `${hi} thank you for your enquiry. Unfortunately this is out of stock at the moment.`, closing: "You are on our priority waitlist and we will message you the moment stock arrives." };
      case "quote_restocked":
        return { intro: `${hi} good news! The stock you asked for is available again:`, closing: "Reply YES to confirm and we will reserve it for you." };
      case "bill":
        return { intro: `${hi} thank you for your order. Your invoice is ready:`, closing: "Please let us know once payment is done. We will share dispatch details." };
      case "counter_offer":
        return (ctx.negotiationRound ?? 1) <= 1
          ? {
              intro: `${ji(ctx.buyerName)}, our rates are already very competitive and the quality is genuine. But since this is your first order with us and we want a long-term relationship, I spoke to the owner and we can offer you a special price:`,
              closing: "Please confirm with a YES and we will block the stock for you right away.",
            }
          : {
              intro: `${ji(ctx.buyerName)}, I understand your point. Considering the volume, we have stretched our margin further for you. This is a very good rate in the market:`,
              closing: "Do confirm soon, as stock is moving fast. Reply YES and it is yours.",
            };
      case "final_offer":
        return {
          intro: `${ji(ctx.buyerName)}, honestly this is our last and best price. We are already working on very thin margins to start this relationship with you:`,
          closing: "We cannot go below this. Please confirm with a YES and we will dispatch on priority.",
        };
    }
  }
}
