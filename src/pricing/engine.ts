/**
 * Pricing & billing rules engine. Pure, deterministic, no AI.
 *
 * The owner writes the rules once (data/seed/pricing-rules.json); the engine applies
 * them in this fixed order and explains every step:
 *
 *   1. unit price   list price -> quantity slab -> buyer contract price
 *   2. gross        qty x unit price                       (200 x Rs10 = Rs2,000)
 *   3. line disc.   product / category / buyer % off the line
 *   4. bill disc.   order-value tier % + owner's extra %  (before or after tax: configurable)
 *   5. tax          GST per product; CGST+SGST if buyer is in the seller's state, else IGST; cess
 *   6. rounding     to the nearest rupee with a round-off line
 *
 * All money is computed in paise (integers) so totals never drift by a paisa.
 */
import rulesJson from "../../data/seed/pricing-rules.json" with { type: "json" };

export interface Slab {
  minQty: number;
  unitPrice: number;
}

export interface ProductRule {
  slabs?: Slab[];
  lineDiscountPct?: number;
}

export interface BuyerRule {
  prices?: Record<string, number>;
  lineDiscountPct?: number;
}

export interface PricingRules {
  version: string;
  sellerState: string;
  pricesIncludeTax: boolean;
  billDiscountStage: "before_tax" | "after_tax";
  rounding: "nearest_rupee" | "none";
  products: Record<string, ProductRule>;
  categories: Record<string, ProductRule>;
  billDiscounts: { minSubtotal: number; pct: number }[];
  buyers: Record<string, BuyerRule>;
  cess: Record<string, number>;
  negotiation?: NegotiationRules;
}

export interface NegotiationRules {
  enabled: boolean;
  newClientsOnly: boolean;
  /** Concession ladder, % off the bill: first counter, second, final. */
  steps: number[];
  maxDiscountPct: number;
  /** Per-SKU caps, e.g. { "SW-BOAT-XTEND": { "maxDiscountPct": 3 } } */
  products?: Record<string, { maxDiscountPct: number }>;
}

export interface PriceInputLine {
  sku: string;
  name: string;
  category: string;
  hsn?: string;
  unit?: string;
  qty: number;
  listPrice: number;
  gstRate: number;
}

export interface PriceContext {
  buyerKey?: string | null;
  /** Buyer's state; null when not known yet (quote stage). Decides CGST+SGST vs IGST. */
  buyerState?: string | null;
  /** One-off extra bill discount the owner granted on this order. */
  extraDiscountPct?: number;
  /** Unit prices the owner typed for this order. Beat list, slab and contract prices. */
  unitPriceOverrides?: Record<string, number>;
  /** Owner chose "remove all discounts": no line, order-value or extra discount. Slab and owner prices still apply. */
  waiveDiscounts?: boolean;
  /** Special price agreed in negotiation (owner-approved), as % off the bill. Applies even when discounts are waived. */
  negotiatedPct?: number;
}

export type TaxMode = "intra" | "inter" | "unknown";

export interface PricedLine {
  sku: string;
  name: string;
  hsn: string;
  unit: string;
  qty: number;
  listPrice: number;
  unitPrice: number;
  priceSource: "list" | "slab" | "buyer" | "owner";
  gross: number;
  lineDiscountPct: number;
  lineDiscount: number;
  billDiscountShare: number;
  taxable: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  gst: number;
  cess: number;
  total: number;
}

export interface PriceBreakdown {
  ruleVersion: string;
  taxMode: TaxMode;
  lines: PricedLine[];
  totals: {
    gross: number;
    lineDiscount: number;
    subtotal: number;
    billDiscountPct: number;
    /** Parts of billDiscountPct: the automatic order-value tier and the owner's extra. */
    tierDiscountPct: number;
    extraDiscountPct: number;
    negotiatedPct: number;
    discountsWaived: boolean;
    billDiscount: number;
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    gst: number;
    cess: number;
    roundOff: number;
    grandTotal: number;
  };
  steps: string[];
}

export function loadRules(): PricingRules {
  return rulesJson as unknown as PricingRules;
}

const p = (rupees: number) => Math.round(rupees * 100);
const r = (paise: number) => paise / 100;
const pct = (paise: number, percent: number) => Math.round((paise * percent) / 100);

/** "2%", "2% order value + 5% extra", "3% special price", ... */
export function discountLabel(t: { billDiscountPct: number; tierDiscountPct?: number; extraDiscountPct?: number; negotiatedPct?: number }): string {
  const parts = [
    t.tierDiscountPct ? `${t.tierDiscountPct}% order value` : null,
    t.extraDiscountPct ? `${t.extraDiscountPct}% extra` : null,
    t.negotiatedPct ? `${t.negotiatedPct}% special price` : null,
  ].filter(Boolean);
  if (parts.length > 1 || t.negotiatedPct) return parts.join(" + ");
  return `${t.billDiscountPct}%`;
}

export function formatINR(rupees: number): string {
  return "₹" + rupees.toLocaleString("en-IN", { minimumFractionDigits: rupees % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

function normState(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/** Split `amount` across `weights` proportionally; shares always sum exactly to amount. */
function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || amount === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const shares = raw.map(Math.floor);
  let left = amount - shares.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) shares[order[k].i]++;
  return shares;
}

export function priceOrder(lines: PriceInputLine[], ctx: PriceContext = {}, rules: PricingRules = loadRules()): PriceBreakdown {
  const steps: string[] = [];
  const buyerRule = (ctx.buyerKey && rules.buyers[ctx.buyerKey]) || {};
  const taxMode: TaxMode = !ctx.buyerState
    ? "unknown"
    : normState(ctx.buyerState) === normState(rules.sellerState)
      ? "intra"
      : "inter";

  // 1-3: unit price, gross, line discount
  const work = lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error(`Invalid quantity for ${l.sku}`);
    const prodRule = rules.products[l.sku] ?? {};
    const catRule = rules.categories[l.category] ?? {};
    let unitPrice = l.listPrice;
    let priceSource: PricedLine["priceSource"] = "list";
    const slab = [...(prodRule.slabs ?? catRule.slabs ?? [])].sort((a, b) => b.minQty - a.minQty).find((s) => l.qty >= s.minQty);
    if (slab) {
      unitPrice = slab.unitPrice;
      priceSource = "slab";
      steps.push(`${l.name}: ${l.qty} ≥ ${slab.minQty} units, slab price ${formatINR(slab.unitPrice)} (list ${formatINR(l.listPrice)})`);
    }
    const contract = buyerRule.prices?.[l.sku];
    if (contract !== undefined) {
      unitPrice = contract;
      priceSource = "buyer";
      steps.push(`${l.name}: buyer contract price ${formatINR(contract)}`);
    }
    const override = ctx.unitPriceOverrides?.[l.sku];
    if (override !== undefined && override !== null) {
      if (!(Number.isFinite(override) && override > 0)) throw new Error(`Invalid price for ${l.name}`);
      unitPrice = Math.round(override * 100) / 100;
      priceSource = "owner";
      steps.push(`${l.name}: price set by owner ${formatINR(unitPrice)}`);
    }
    const gross = l.qty * p(unitPrice);
    steps.push(`${l.name}: ${l.qty} × ${formatINR(unitPrice)} = ${formatINR(r(gross))}`);
    const ldPct = ctx.waiveDiscounts ? 0 : (prodRule.lineDiscountPct ?? catRule.lineDiscountPct ?? 0) + (buyerRule.lineDiscountPct ?? 0);
    const lineDiscount = pct(gross, ldPct);
    if (ldPct) steps.push(`${l.name}: line discount ${ldPct}% = −${formatINR(r(lineDiscount))}`);
    return { l, unitPrice, priceSource, gross, ldPct, lineDiscount, net: gross - lineDiscount };
  });

  const subtotal = work.reduce((s, w) => s + w.net, 0);

  // 4: bill discount
  const waived = Boolean(ctx.waiveDiscounts);
  const tier = waived ? undefined : [...rules.billDiscounts].sort((a, b) => b.minSubtotal - a.minSubtotal).find((t) => r(subtotal) >= t.minSubtotal);
  const extraPct = waived ? 0 : ctx.extraDiscountPct ?? 0;
  const negotiatedPct = ctx.negotiatedPct ?? 0;
  const billPct = Math.round(((tier?.pct ?? 0) + extraPct + negotiatedPct) * 100) / 100;
  if (waived) steps.push("All discounts removed by owner");
  if (tier) steps.push(`Order value ${formatINR(r(subtotal))} ≥ ${formatINR(tier.minSubtotal)}: bill discount ${tier.pct}%`);
  if (extraPct) steps.push(`Extra discount approved by owner: ${extraPct}%`);
  if (negotiatedPct) steps.push(`Special price agreed in negotiation: ${negotiatedPct}%`);

  let shares = work.map(() => 0);
  let billDiscount = 0;
  if (billPct && rules.billDiscountStage === "before_tax") {
    billDiscount = pct(subtotal, billPct);
    shares = allocate(billDiscount, work.map((w) => w.net));
    steps.push(`Bill discount ${billPct}% before tax = −${formatINR(r(billDiscount))}`);
  }

  // 5: tax
  const priced: PricedLine[] = work.map((w, i) => {
    const value = w.net - shares[i];
    const rate = w.l.gstRate;
    const taxable = rules.pricesIncludeTax ? Math.round((value * 100) / (100 + rate)) : value;
    const gst = rules.pricesIncludeTax ? value - taxable : pct(taxable, rate);
    const cess = pct(taxable, rules.cess[w.l.sku] ?? 0);
    let cgst = 0, sgst = 0, igst = 0;
    if (taxMode === "intra") {
      cgst = Math.round(gst / 2);
      sgst = gst - cgst;
    } else if (taxMode === "inter") {
      igst = gst;
    }
    return {
      sku: w.l.sku,
      name: w.l.name,
      hsn: w.l.hsn ?? "",
      unit: w.l.unit ?? "pcs",
      qty: w.l.qty,
      listPrice: w.l.listPrice,
      unitPrice: w.unitPrice,
      priceSource: w.priceSource,
      gross: w.gross,
      lineDiscountPct: w.ldPct,
      lineDiscount: w.lineDiscount,
      billDiscountShare: shares[i],
      taxable,
      gstRate: rate,
      cgst, sgst, igst, gst, cess,
      total: taxable + gst + cess,
    };
  });

  const sum = (k: keyof PricedLine) => priced.reduce((s, l) => s + (l[k] as number), 0);
  const taxableT = sum("taxable"), gstT = sum("gst"), cessT = sum("cess");
  const modeLabel = taxMode === "intra" ? "CGST + SGST (same state)" : taxMode === "inter" ? "IGST (inter-state)" : "GST (split decided once delivery state is known)";
  steps.push(`Tax: ${modeLabel} = ${formatINR(r(gstT))}${rules.pricesIncludeTax ? " (prices include tax)" : ""}`);

  let afterTax = taxableT + gstT + cessT;
  if (billPct && rules.billDiscountStage === "after_tax") {
    billDiscount = pct(afterTax, billPct);
    afterTax -= billDiscount;
    steps.push(`Bill discount ${billPct}% after tax = −${formatINR(r(billDiscount))}`);
  }

  // 6: rounding
  const grand = rules.rounding === "nearest_rupee" ? Math.round(afterTax / 100) * 100 : afterTax;
  const roundOff = grand - afterTax;
  if (roundOff) steps.push(`Round off ${roundOff > 0 ? "+" : "−"}${formatINR(r(Math.abs(roundOff)))}`);
  steps.push(`Grand total ${formatINR(r(grand))}`);

  const toRupees = (l: PricedLine): PricedLine => ({
    ...l,
    gross: r(l.gross), lineDiscount: r(l.lineDiscount), billDiscountShare: r(l.billDiscountShare),
    taxable: r(l.taxable), cgst: r(l.cgst), sgst: r(l.sgst), igst: r(l.igst), gst: r(l.gst), cess: r(l.cess), total: r(l.total),
  });

  return {
    ruleVersion: rules.version,
    taxMode,
    lines: priced.map(toRupees),
    totals: {
      gross: r(sum("gross")),
      lineDiscount: r(sum("lineDiscount")),
      subtotal: r(subtotal),
      billDiscountPct: billPct,
      tierDiscountPct: tier?.pct ?? 0,
      extraDiscountPct: extraPct,
      negotiatedPct,
      discountsWaived: waived,
      billDiscount: r(billDiscount),
      taxable: r(taxableT),
      cgst: r(sum("cgst")),
      sgst: r(sum("sgst")),
      igst: r(sum("igst")),
      gst: r(gstT),
      cess: r(cessT),
      roundOff: r(roundOff),
      grandTotal: r(grand),
    },
    steps,
  };
}
