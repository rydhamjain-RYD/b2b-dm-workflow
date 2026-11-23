// Owner price overrides, removing discounts, dispatch/tracking, and negotiation.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { one } from "../src/db.ts";
import { setAssistant } from "../src/ai/index.ts";
import { RulesAssistant } from "../src/ai/fallback.ts";
import {
  handleInbound, ownerApprove, ownerDispatch, ownerMarkDelivered, ownerSetDiscount, ownerUpdatePricing,
} from "../src/orders/service.ts";
import { activeOrder, getOrder, upsertBuyer, conversation } from "../src/orders/repo.ts";
import { listApprovals } from "../src/approvals/repo.ts";
import { getInvoice } from "../src/invoices/invoices.ts";

const WATCH = "SW-BOAT-XTEND";
const DELIVERY = "Acme Retail Pvt Ltd, GSTIN 27AAACA1234A1Z5, 12 MG Road, Camp, Pune, Maharashtra 411001, contact: Ravi 9876543210";
const say = (handle: string, text: string) => handleInbound({ channel: "simulator", handle, name: handle, text });
const pending = async (orderId: number) => {
  const a = (await listApprovals("pending")).filter((x) => x.order_id === orderId);
  assert.equal(a.length, 1, `expected one pending approval for order ${orderId}`);
  return a[0];
};
const orderOf = async (handle: string) => {
  const o = await activeOrder((await upsertBuyer("simulator", handle, null)).id);
  assert.ok(o, `no active order for ${handle}`);
  return o;
};
const setup = async () => {
  await freshDb();
  setAssistant(new RulesAssistant());
};

describe("owner pricing controls", () => {
  beforeEach(setup);

  test("owner sets a unit price: quote re-priced, and the bill uses the same price", async () => {
    await say("acme", "need 500 boat smartwatch");
    const order = await orderOf("acme");
    await ownerUpdatePricing((await pending(order.id)).id, { prices: { [WATCH]: 1700 } });
    const q2 = await pending(order.id);
    assert.match(q2.draft_text, /500 pcs × ₹1,700 = ₹8,50,000/);
    // 8,50,000 still >= 5L, so the 2% order-value discount remains: 8,33,000 + 18% = 9,82,940
    assert.match(q2.draft_text, /Total payable: ₹9,82,940/);
    assert.equal((q2.payload.quote as { breakdown: { lines: { priceSource: string }[] } }).breakdown.lines[0].priceSource, "owner");

    await ownerApprove(q2.id);
    await say("acme", "yes");
    await say("acme", DELIVERY);
    const bill = await pending(order.id);
    assert.match(bill.draft_text, /500 pcs = ₹8,33,000/);
    assert.deepEqual(bill.payload.warnings, [], "bill matches the approved quote");
    const inv = (await getInvoice((await getOrder(order.id)).invoice_id!))!;
    assert.equal(inv.payload.breakdown.lines[0].unitPrice, 1700);
  });

  test("clearing the price goes back to the normal (slab) price", async () => {
    await say("acme", "need 500 boat smartwatch");
    const order = await orderOf("acme");
    await ownerUpdatePricing((await pending(order.id)).id, { prices: { [WATCH]: 1700 } });
    await ownerUpdatePricing((await pending(order.id)).id, { prices: { [WATCH]: null } });
    assert.match((await pending(order.id)).draft_text, /500 pcs × ₹1,750/);
  });

  test("remove all discounts: plain price; restore brings them back", async () => {
    await say("acme", "need 100 Noise smartwatches");
    const order = await orderOf("acme");
    await ownerSetDiscount((await pending(order.id)).id, 3);
    await ownerUpdatePricing((await pending(order.id)).id, { waiveDiscounts: true });
    let d = (await pending(order.id)).draft_text;
    // 100 x 2100 = 2,10,000, no 5% line discount, no 3% extra; GST 37,800 -> 2,47,800
    assert.doesNotMatch(d, /Discount/);
    assert.doesNotMatch(d, /less 5%/);
    assert.match(d, /Total payable: ₹2,47,800/);
    assert.equal((await getOrder(order.id)).extra_discount_pct, 0);
    await ownerUpdatePricing((await pending(order.id)).id, { waiveDiscounts: false });
    d = (await pending(order.id)).draft_text;
    assert.match(d, /less 5%/);
    assert.match(d, /Total payable: ₹2,35,410/);
  });

  test("prices for items not on the order, or non-positive prices, are refused", async () => {
    await say("acme", "need 10 boat smartwatch");
    const q = await pending((await orderOf("acme")).id);
    await assert.rejects(ownerUpdatePricing(q.id, { prices: { "PB-MI-20K": 100 } }), /not on this order/);
    await assert.rejects(ownerUpdatePricing(q.id, { prices: { [WATCH]: -5 } }), /positive/);
  });
});

describe("dispatch and tracking", () => {
  beforeEach(setup);

  const billed = async () => {
    await say("acme", "need 10 boat smartwatch");
    await ownerApprove((await pending((await orderOf("acme")).id)).id);
    await say("acme", "yes");
    await say("acme", DELIVERY);
    const order = await orderOf("acme");
    await ownerApprove((await pending(order.id)).id);
    return getOrder(order.id);
  };

  test("owner enters vehicle details: buyer is told, tracking answers, delivery closes it", async () => {
    const order = await billed();
    assert.equal(order.state, "CLOSED");
    await assert.rejects(ownerDispatch(order.id, { transporter: "VRL Logistics", vehicleNo: "12345" }), /doesn't look like a vehicle number/);
    await assert.rejects(ownerDispatch(order.id, { transporter: "", vehicleNo: "MH12AB1234" }), /Transporter/);
    await assert.rejects(ownerDispatch(order.id, { transporter: "VRL", vehicleNo: "MH12AB1234", ewayBillNo: "123" }), /12 digits/);

    const d = await ownerDispatch(order.id, {
      transporter: "VRL Logistics", vehicleNo: "mh 12 ab 1234", lrNo: "VRL-55821", ewayBillNo: "331002456789",
      driverName: "Suresh", driverPhone: "9822012345", expectedDelivery: "2026-11-26",
    });
    assert.equal(d.state, "DISPATCHED");
    assert.equal(d.dispatch!.vehicleNo, "MH12AB1234");
    const msg = (await conversation(order.buyer_id)).at(-1)!;
    assert.equal(msg.kind, "dispatch");
    assert.match(msg.text, /has been dispatched/);
    assert.match(msg.text, /Vehicle no\.: MH12AB1234/);
    assert.match(msg.text, /E-way bill no\.: 331002456789/);

    const out = await say("acme", "where is my order?");
    assert.match(out[0].text, /on the way/);
    assert.match(out[0].text, /MH12AB1234/);
    assert.equal(await activeOrder(order.buyer_id), null, "tracking question did not open a new order");

    await ownerMarkDelivered(order.id);
    assert.equal((await getOrder(order.id)).state, "DELIVERED");
    const next = await say("acme", "need 5 Mi power bank");
    assert.equal(next.at(-1)!.kind, "ack", "a new requirement starts a fresh order");
  });

  test("dispatch is only possible after billing", async () => {
    await say("acme", "need 10 boat smartwatch");
    const order = await orderOf("acme");
    await assert.rejects(ownerDispatch(order.id, { transporter: "VRL", vehicleNo: "MH12AB1234" }), /only billed orders/);
  });

  test("Bharat-series vehicle numbers are accepted", async () => {
    const order = await billed();
    const d = await ownerDispatch(order.id, { transporter: "Own vehicle", vehicleNo: "22 BH 1234 AA" });
    assert.equal(d.dispatch!.vehicleNo, "22BH1234AA");
  });
});

describe("negotiation", () => {
  beforeEach(setup);

  const quoted = async (handle: string, text = "need 100 boat smartwatch") => {
    await say(handle, text);
    const order = await orderOf(handle);
    await ownerApprove((await pending(order.id)).id);
    return order;
  };
  type Neg = { round: number; offeredPct: number; final: boolean; returningBuyer: boolean; overLimit: boolean; askPct: number | null };
  const neg = (a: { payload: Record<string, unknown> }) => a.payload.negotiation as Neg;

  test("new buyer bargains: 1.5% -> meets their ask -> 3% -> final 5%, each approved by the owner", async () => {
    const order = await quoted("newco"); // 100 >= 100 slab: Rs1,800/unit

    const out = await say("newco", "Too costly yaar, give best price");
    assert.match(out[0].text, /discuss with the owner/);
    assert.equal((await getOrder(order.id)).state, "QUOTE_PENDING_APPROVAL", "counter-offer waits for the owner");
    let a = await pending(order.id);
    assert.equal(neg(a).round, 1);
    assert.equal(neg(a).offeredPct, 1.5);
    assert.match(a.draft_text, /first order/);
    assert.match(a.draft_text, /Discount \(1\.5% special price\)/);
    assert.equal((await conversation(order.buyer_id)).filter((m) => m.kind === "quote").length, 1, "only the original quote was sent so far");
    await ownerApprove(a.id);

    await say("newco", "can you do 1750 per piece?");
    a = await pending(order.id);
    // 1750 vs 1800 = 2.78% asked; next step is 3%, so meet them at 2.5%
    assert.equal(Math.round(neg(a).askPct! * 100) / 100, 2.78);
    assert.equal(neg(a).offeredPct, 2.5);
    await ownerApprove(a.id);

    await say("newco", "still high, thoda kam karo");
    a = await pending(order.id);
    assert.equal(neg(a).offeredPct, 3);
    await ownerApprove(a.id);

    await say("newco", "last price?");
    a = await pending(order.id);
    assert.equal(neg(a).offeredPct, 5);
    assert.equal(neg(a).final, true);
    assert.match(a.draft_text, /last and best price/);
    await ownerApprove(a.id);

    await say("newco", "competitor gives cheaper, reduce more");
    a = await pending(order.id);
    assert.equal(neg(a).offeredPct, 5, "never beyond the 5% limit");
    assert.equal(neg(a).overLimit, true);
    const alert = await one<{ message: string }>("SELECT message FROM alerts WHERE kind='negotiation' ORDER BY id DESC LIMIT 1");
    assert.match(alert!.message, /more than your 5% negotiation limit/);
    await ownerApprove(a.id);

    await say("newco", "ok done, confirmed");
    await say("newco", DELIVERY);
    const inv = (await getInvoice((await getOrder(order.id)).invoice_id!))!;
    assert.equal(inv.payload.breakdown.totals.negotiatedPct, 5, "agreed special price carries to the bill");
    // 100 x 1800 = 1,80,000 - 5% = 1,71,000 + 18% = 2,01,780
    assert.equal(inv.payload.breakdown.totals.grandTotal, 201780);
  });

  test("buyer asks for more than the limit up front: first step only, and the owner is alerted", async () => {
    const order = await quoted("newco");
    await say("newco", "give 10% discount");
    const a = await pending(order.id);
    assert.equal(neg(a).offeredPct, 1.5);
    assert.equal(neg(a).overLimit, true);
  });

  test("owner can change the AI's proposed concession before approving", async () => {
    const order = await quoted("newco");
    await say("newco", "too expensive");
    await ownerUpdatePricing((await pending(order.id)).id, { negotiatedPct: 1 });
    const a = await pending(order.id);
    assert.equal(neg(a).offeredPct, 1);
    assert.match(a.draft_text, /Discount \(1% special price\)/);
    assert.match(a.draft_text, /first order/, "still worded as a counter-offer");
  });

  test("returning buyer bargains: no automatic concession, the owner is asked to decide", async () => {
    await say("old", "need 10 boat smartwatch");
    await ownerApprove((await pending((await orderOf("old")).id)).id);
    await say("old", "yes");
    await say("old", DELIVERY);
    await ownerApprove((await pending((await orderOf("old")).id)).id);

    const order = await quoted("old");
    await say("old", "rate is high, kuch kam karo");
    const a = await pending(order.id);
    assert.equal(neg(a).returningBuyer, true);
    assert.equal((await getOrder(order.id)).negotiation, null, "no concession recorded");
    assert.doesNotMatch(a.draft_text, /special price/);
    const alert = await one<{ message: string }>("SELECT message FROM alerts WHERE kind='negotiation'");
    assert.match(alert!.message, /returning client/);
  });

  test("'too costly' is bargaining, not a cancellation", async () => {
    const order = await quoted("newco");
    await say("newco", "too costly");
    assert.notEqual((await getOrder(order.id)).state, "CANCELLED");
  });
});
