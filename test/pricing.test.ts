import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceOrder, type PricingRules, type PriceInputLine } from "../src/pricing/engine.ts";
import { extractDelivery, extractItems } from "../src/ai/fallback.ts";
import { matchProduct, type Product } from "../src/orders/matcher.ts";

describe("rule-based reading (used when Claude is not configured)", () => {
  test("splits a typical delivery message into fields", () => {
    const d = extractDelivery("Acme Retail Pvt Ltd, GSTIN 27AAACA1234A1Z5, 12 MG Road, Camp, Pune, Maharashtra 411001, contact: Ravi 9876543210");
    assert.deepEqual(d, {
      businessName: "Acme Retail Pvt Ltd", gstin: "27AAACA1234A1Z5", contactName: "Ravi", phone: "9876543210",
      line: "12 MG Road, Camp", city: "Pune", state: "Maharashtra", pincode: "411001",
    });
  });

  test("reads details written on separate lines, with a city instead of a state", () => {
    const d = extractDelivery("mesa\ngstn dhdiahsdnsd12333n\nbanergatta road , bangalore\nsinchan rai\n8310817359");
    assert.deepEqual(d, {
      businessName: "mesa", gstin: "DHDIAHSDNSD12333N", contactName: "sinchan rai", phone: "8310817359",
      line: "banergatta road", city: "bangalore", state: "Karnataka", pincode: null,
    });
  });

  test("reads quantities like 5k and several items in one message", () => {
    assert.deepEqual(extractItems("need 5k PET bottles and 200 boAt earbuds"), [
      { productText: "pet bottles", brand: null, qty: 5000 },
      { productText: "boat earbuds", brand: null, qty: 200 },
    ]);
  });

  test("matches brand + category, and refuses to guess between brands", () => {
    const mk = (sku: string, brand: string, category: string, aliases: string[]): Product =>
      ({ sku, name: `${brand} ${category}`, brand, category, aliases, unit: "pcs", unit_price: 1, gst_rate: 18, hsn: "", on_hand: 1 });
    const catalog = [mk("A", "boAt", "smartwatch", ["watch"]), mk("B", "Noise", "smartwatch", ["watch"]), mk("C", "boAt", "earbuds", ["tws"])];
    assert.equal((matchProduct("boat smart watches", null, catalog) as { product: Product }).product.sku, "A");
    assert.equal(matchProduct("smartwatch", null, catalog).status, "ambiguous");
    assert.equal(matchProduct("boat", null, catalog).status, "ambiguous");
    assert.equal(matchProduct("laptop", null, catalog).status, "none");
  });
});

const base: PricingRules = {
  version: "test",
  sellerState: "Maharashtra",
  pricesIncludeTax: false,
  billDiscountStage: "before_tax",
  rounding: "nearest_rupee",
  products: {},
  categories: {},
  billDiscounts: [],
  buyers: {},
  cess: {},
};
const rules = (over: Partial<PricingRules>): PricingRules => ({ ...base, ...over });

const bottle = (qty: number, gstRate = 0): PriceInputLine => ({
  sku: "BOTTLE", name: "Bottle", category: "bottle", qty, listPrice: 10, gstRate,
});
const watch = (qty: number): PriceInputLine => ({
  sku: "WATCH", name: "Watch", category: "smartwatch", qty, listPrice: 1850, gstRate: 18,
});

describe("pricing engine", () => {
  test("simple: 200 bottles x Rs10 = Rs2,000", () => {
    const b = priceOrder([bottle(200)], {}, base);
    assert.equal(b.totals.gross, 2000);
    assert.equal(b.totals.grandTotal, 2000);
  });

  test("quantity slab picks the highest slab reached", () => {
    const rs = rules({ products: { WATCH: { slabs: [{ minQty: 100, unitPrice: 1800 }, { minQty: 400, unitPrice: 1750 }] } } });
    assert.equal(priceOrder([watch(99)], {}, rs).lines[0].unitPrice, 1850);
    assert.equal(priceOrder([watch(100)], {}, rs).lines[0].unitPrice, 1800);
    const b = priceOrder([watch(500)], {}, rs);
    assert.equal(b.lines[0].unitPrice, 1750);
    assert.equal(b.totals.gross, 875000);
  });

  test("line discount is applied before tax", () => {
    const rs = rules({ products: { WATCH: { lineDiscountPct: 10 } } });
    const b = priceOrder([watch(10)], { buyerState: "Maharashtra" }, rs);
    // 10 x 1850 = 18500, -10% = 16650 taxable, 18% GST = 2997
    assert.equal(b.totals.taxable, 16650);
    assert.equal(b.totals.gst, 2997);
    assert.equal(b.totals.grandTotal, 19647);
  });

  test("bill discount before tax vs after tax give different totals", () => {
    const tiers = [{ minSubtotal: 10000, pct: 5 }];
    const before = priceOrder([watch(10)], { buyerState: "Gujarat" }, rules({ billDiscounts: tiers }));
    // 18500 - 925 = 17575 taxable, IGST 3163.50 -> 20738.50 -> rounds to 20739
    assert.equal(before.totals.billDiscount, 925);
    assert.equal(before.totals.taxable, 17575);
    assert.equal(before.totals.igst, 3163.5);
    assert.equal(before.totals.grandTotal, 20739);
    const after = priceOrder([watch(10)], { buyerState: "Gujarat" }, rules({ billDiscounts: tiers, billDiscountStage: "after_tax" }));
    // 18500 + 3330 = 21830, -5% (1091.50) = 20738.50 -> 20739 (same here, but tax base differs)
    assert.equal(after.totals.taxable, 18500);
    assert.equal(after.totals.gst, 3330);
    assert.equal(after.totals.billDiscount, 1091.5);
  });

  test("owner's extra discount stacks on the tier discount", () => {
    const b = priceOrder([watch(10)], { extraDiscountPct: 2 }, rules({ billDiscounts: [{ minSubtotal: 10000, pct: 3 }] }));
    assert.equal(b.totals.billDiscountPct, 5);
    assert.equal(b.totals.billDiscount, 925);
  });

  test("CGST+SGST inside the seller's state, IGST outside, GST when unknown", () => {
    const intra = priceOrder([watch(1)], { buyerState: "maharashtra" }, base);
    assert.equal(intra.taxMode, "intra");
    assert.equal(intra.totals.cgst, 166.5);
    assert.equal(intra.totals.sgst, 166.5);
    assert.equal(intra.totals.igst, 0);
    const inter = priceOrder([watch(1)], { buyerState: "Karnataka" }, base);
    assert.equal(inter.taxMode, "inter");
    assert.equal(inter.totals.igst, 333);
    const unknown = priceOrder([watch(1)], {}, base);
    assert.equal(unknown.taxMode, "unknown");
    assert.equal(unknown.totals.gst, 333);
  });

  test("mixed GST rates are taxed per line and a bill discount is shared exactly", () => {
    const b = priceOrder(
      [watch(3), bottle(333, 12)],
      { buyerState: "Karnataka" },
      rules({ billDiscounts: [{ minSubtotal: 1, pct: 7 }] }),
    );
    const shares = b.lines.reduce((s, l) => s + l.billDiscountShare, 0);
    assert.equal(Math.round(shares * 100), Math.round(b.totals.billDiscount * 100));
    assert.equal(b.lines[0].gstRate, 18);
    assert.equal(b.lines[1].gstRate, 12);
    const recomputed = b.lines.reduce((s, l) => s + l.taxable + l.gst, 0);
    assert.equal(Math.round(recomputed + b.totals.roundOff), b.totals.grandTotal);
  });

  test("prices that include tax are split back into taxable value + GST", () => {
    const b = priceOrder([{ ...watch(1), listPrice: 1180 }], { buyerState: "Delhi" }, rules({ pricesIncludeTax: true }));
    assert.equal(b.totals.taxable, 1000);
    assert.equal(b.totals.igst, 180);
    assert.equal(b.totals.grandTotal, 1180);
  });

  test("rounding to the nearest rupee records the round-off", () => {
    const b = priceOrder([{ ...bottle(1, 18), listPrice: 10.55 }], {}, base);
    // 10.55 + 1.90 = 12.45 -> 12
    assert.equal(b.totals.roundOff, -0.45);
    assert.equal(b.totals.grandTotal, 12);
  });

  test("buyer contract price overrides slab and list", () => {
    const rs = rules({
      products: { WATCH: { slabs: [{ minQty: 1, unitPrice: 1800 }] } },
      buyers: { "acme": { prices: { WATCH: 1700 } } },
    });
    const b = priceOrder([watch(2)], { buyerKey: "acme" }, rs);
    assert.equal(b.lines[0].unitPrice, 1700);
    assert.equal(b.lines[0].priceSource, "buyer");
  });

  test("invalid quantities are rejected", () => {
    assert.throws(() => priceOrder([watch(0)], {}, base));
    assert.throws(() => priceOrder([watch(1.5)], {}, base));
  });
});
