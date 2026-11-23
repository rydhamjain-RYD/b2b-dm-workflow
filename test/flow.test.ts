import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, setStock } from "./helpers.ts";
import { one, all } from "../src/db.ts";
import { advanceClock } from "../src/clock.ts";
import { settings } from "../src/config.ts";
import { setAssistant } from "../src/ai/index.ts";
import { RulesAssistant } from "../src/ai/fallback.ts";
import { handleInbound, ownerApprove, ownerReject, ownerSetDiscount, sweep } from "../src/orders/service.ts";
import { activeOrder, getOrder, upsertBuyer, conversation } from "../src/orders/repo.ts";
import { listApprovals } from "../src/approvals/repo.ts";
import { atp, reservationsFor } from "../src/inventory/ledger.ts";
import { sendToBuyer, ApprovalRequiredError } from "../src/channels/index.ts";
import { erp } from "../src/erp/mockTally.ts";
import { getInvoice } from "../src/invoices/invoices.ts";

const WATCH = "SW-BOAT-XTEND";
const say = (handle: string, text: string, name = handle) => handleInbound({ channel: "simulator", handle, name, text });
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
const tallyStock = async (sku: string) => (await erp.listItems()).find((i) => i.sku === sku)!.onHand;
const DELIVERY = "Acme Retail Pvt Ltd, GSTIN 27AAACA1234A1Z5, 12 MG Road, Camp, Pune, Maharashtra 411001, contact: Ravi 9876543210";

const setup = async () => {
  await freshDb();
  setAssistant(new RulesAssistant());
};

describe("order flow", () => {
  beforeEach(setup);

  test("the full 500-smartwatch sale, with both owner approvals", async () => {
    let out = await say("acme", "Hi, we have a requirement");
    assert.match(out[0].text, /share your requirement/i);

    out = await say("acme", "We need 500 boAt smartwatches");
    assert.equal(out.at(-1)!.kind, "ack");
    let order = await orderOf("acme");
    assert.equal(order.state, "QUOTE_PENDING_APPROVAL");
    assert.equal(await atp(WATCH), 0, "the 500 units are held for this buyer while the owner reviews");
    assert.equal((await conversation(order.buyer_id)).filter((m) => m.kind === "quote").length, 0, "nothing quoted to the buyer yet");

    const q = await pending(order.id);
    assert.equal(q.gate, "quote");
    // 500 >= 400 slab -> Rs1,750; subtotal 8,75,000 >= 5L -> 2% off = 8,57,500; GST 18% = 1,54,350
    assert.match(q.draft_text, /500 pcs × ₹1,750/);
    assert.match(q.draft_text, /Total payable: ₹10,11,850/);

    const sent = await ownerApprove(q.id);
    assert.equal(sent.status, "sent");
    assert.equal(sent.message!.kind, "quote");
    order = await getOrder(order.id);
    assert.equal(order.state, "AWAITING_BUYER_CONFIRMATION");
    assert.equal((await reservationsFor(order.id))[0].state, "QUOTED_HOLD");

    out = await say("acme", "Yes, go ahead");
    assert.match(out[0].text, /delivery and billing details/);
    assert.equal((await getOrder(order.id)).state, "AWAITING_DELIVERY");
    assert.equal((await reservationsFor(order.id))[0].state, "COMMITTED");

    await say("acme", DELIVERY);
    order = await getOrder(order.id);
    assert.equal(order.state, "BILL_PENDING_APPROVAL");
    const bill = await pending(order.id);
    assert.equal(bill.gate, "bill");
    assert.deepEqual(bill.payload.warnings, []);
    assert.match(bill.draft_text, /Deliver to: 12 MG Road, Camp, Pune, Maharashtra 411001\n/);
    const inv = (await getInvoice(order.invoice_id!))!;
    assert.equal(inv.status, "draft");
    assert.equal(inv.payload.breakdown.taxMode, "intra", "Pune buyer, Mumbai seller: CGST + SGST");
    assert.equal(inv.payload.breakdown.totals.cgst, 77175);
    assert.equal(inv.payload.breakdown.totals.grandTotal, 1011850);
    assert.equal(inv.payload.buyer.businessName, "Acme Retail Pvt Ltd");
    assert.equal(await tallyStock(WATCH), 500, "Tally untouched until the bill is approved");

    const final = await ownerApprove(bill.id);
    assert.equal(final.message!.kind, "invoice");
    assert.ok(final.message!.text.includes(`/i/${inv.public_token}`), "buyer gets an unguessable invoice link");
    assert.ok(inv.public_token.length >= 20);
    assert.equal((await getOrder(order.id)).state, "CLOSED");
    assert.equal((await getInvoice(order.invoice_id!))!.status, "final");
    assert.equal(await tallyStock(WATCH), 0, "Tally stock reduced by the sale");
    assert.equal((await reservationsFor(order.id))[0].state, "BILLED");
    assert.equal(await atp(WATCH), 0);
  });

  test("owner sets a discount on a pending quote: numbers re-priced, then approved with the discount", async () => {
    await say("acme", "need 100 Noise smartwatches");
    const order = await orderOf("acme");
    const first = await pending(order.id);
    // 100 x 2100 = 2,10,000 less 5% line discount = 1,99,500; GST 35,910 -> 2,35,410
    assert.match(first.draft_text, /Total payable: ₹2,35,410/);

    const next = await ownerSetDiscount(first.id, 3);
    assert.notEqual(next.id, first.id);
    const second = await pending(order.id);
    assert.equal(second.id, next.id);
    // 1,99,500 - 3% (5,985) = 1,93,515; GST 34,832.70 -> 2,28,347.70 -> 2,28,348
    assert.match(second.draft_text, /Discount \(3%\): −₹5,985/);
    assert.match(second.draft_text, /Total payable: ₹2,28,348/);
    assert.equal(second.draft_text.split("\n")[0], first.draft_text.split("\n")[0], "wording kept, only numbers change");
    assert.equal((await listApprovals(null)).find((a) => a.id === first.id)!.status, "superseded");
    await assert.rejects(ownerApprove(first.id), /already superseded/, "the old, undiscounted draft can no longer be sent");

    const res = await ownerApprove(second.id);
    assert.match(res.message!.text, /Total payable: ₹2,28,348/, "the buyer receives the discounted quote");
    await assert.rejects(ownerSetDiscount(second.id, 50.5), /already approved/);
  });

  test("discount carries through to the bill, and can also be changed at the bill stage", async () => {
    await say("acme", "need 100 Noise smartwatches");
    const order = await orderOf("acme");
    await ownerSetDiscount((await pending(order.id)).id, 3);
    await ownerApprove((await pending(order.id)).id);
    await say("acme", "yes");
    await say("acme", DELIVERY);
    let bill = await pending(order.id);
    assert.match(bill.draft_text, /Discount \(3%\)/);
    await ownerSetDiscount(bill.id, 5);
    bill = await pending(order.id);
    assert.match(bill.draft_text, /Discount \(5%\)/);
    assert.ok((bill.payload.warnings as string[]).some((w) => /changed since the quote/.test(w)), "owner is warned the bill differs from the quote");
    const inv = (await getInvoice((await getOrder(order.id)).invoice_id!))!;
    assert.equal(inv.payload.breakdown.totals.billDiscountPct, 5);
  });

  test("owner rejects a draft with a note: AI redrafts and records the note", async () => {
    await say("acme", "need 100 Noise smartwatches");
    const order = await orderOf("acme");
    const first = await pending(order.id);
    await ownerReject(first.id, "Regular customer, be warmer", 2);
    const second = await pending(order.id);
    assert.equal(second.attempt, 2);
    assert.equal(second.owner_note, "Regular customer, be warmer");
    assert.match(second.draft_text, /Discount \(2%\)/);
    assert.equal((await listApprovals(null)).find((a) => a.id === first.id)!.status, "rejected");
    const res = await ownerApprove(second.id, second.draft_text.replace("Hello", "Namaste"));
    assert.match(res.message!.text, /^Namaste/, "owner's edits are what the buyer receives");
  });

  test("two buyers race for the same 500 watches: one is quoted, the other waitlisted, then offered when stock frees", async () => {
    await Promise.all([say("alpha", "need 500 boat smartwatch"), say("beta", "need 300 boat smartwatch")]);
    const a = await orderOf("alpha");
    const b = await orderOf("beta");
    const qa = await pending(a.id);
    const qb = await pending(b.id);
    const offered = [qa, qb].map((q) => (q.payload.quote as { lines: { offered: number }[] }).lines[0].offered);
    assert.equal(offered[0] + offered[1], 500, "never more than 500 promised in total");
    const [winner, loser] = offered[0] === 500 ? [a, b] : [b, a];
    const loserQ = await pending(loser.id);
    assert.match(loserQ.draft_text, /out of stock right now/);

    await ownerApprove((await pending(winner.id)).id);
    await ownerApprove(loserQ.id);
    assert.equal((await getOrder(loser.id)).state, "WAITLISTED");

    await say(winner.id === a.id ? "alpha" : "beta", "sorry, not interested");
    assert.equal((await getOrder(winner.id)).state, "CANCELLED");
    assert.equal(await atp(WATCH), 500);

    const result = await sweep();
    assert.equal(result.offered, 1);
    const offer = await pending(loser.id);
    assert.equal((offer.payload.quote as { situation: string }).situation, "quote_restocked");
    assert.match(offer.draft_text, /good news/i);
  });

  test("partial stock: quote what is available, waitlist the balance", async () => {
    await setStock(WATCH, 500);
    await say("alpha", "need 350 boat smartwatch");
    await say("beta", "need 300 boat smartwatch");
    const beta = await orderOf("beta");
    const q = await pending(beta.id);
    assert.match(q.draft_text, /150 of 300 pcs available/);
    assert.match(q.draft_text, /balance 150 pcs on priority waitlist/);
    const w = await one<{ qty: number }>("SELECT qty FROM waitlist WHERE order_id=$1 AND status='waiting'", beta.id);
    assert.equal(w!.qty, 150);
  });

  test("ambiguous product: the bot asks which one instead of guessing", async () => {
    const out = await say("acme", "need 200 smartwatches");
    assert.match(out[0].text, /which one\?/);
    assert.match(out[0].text, /Noise ColorFit Pro 4/);
    assert.equal((await orderOf("acme")).state, "AWAITING_REQUIREMENT");
    await say("acme", "Noise");
    assert.match((await pending((await orderOf("acme")).id)).draft_text, /Noise ColorFit Pro 4 Smartwatch: 200 pcs/);
  });

  test("missing quantity: the bot asks how many, and a bare number answers it", async () => {
    const out = await say("acme", "Mi power bank");
    assert.match(out[0].text, /How many units of Mi 20000mAh Power Bank/);
    await say("acme", "120");
    assert.match((await pending((await orderOf("acme")).id)).draft_text, /Mi 20000mAh Power Bank: 120 pcs/);
  });

  test("quote expires: stock released, buyer told, 'yes' re-checks and redrafts for the owner", async () => {
    await say("acme", "need 100 boat smartwatch");
    const order = await orderOf("acme");
    await ownerApprove((await pending(order.id)).id);
    advanceClock(settings.quotedHoldMs + 1000);
    await sweep();
    assert.equal((await getOrder(order.id)).state, "EXPIRED");
    assert.match((await conversation(order.buyer_id)).at(-1)!.text, /has expired/);
    assert.equal(await atp(WATCH), 500);
    await say("acme", "yes please");
    assert.equal((await getOrder(order.id)).state, "QUOTE_PENDING_APPROVAL");
    assert.equal(await atp(WATCH), 400);
  });

  test("returning buyer: saved address is offered, 'yes' goes straight to the bill", async () => {
    await say("acme", "need 10 boat smartwatch");
    await ownerApprove((await pending((await orderOf("acme")).id)).id);
    await say("acme", "ok confirmed");
    await say("acme", DELIVERY);
    await ownerApprove((await pending((await orderOf("acme")).id)).id);

    await say("acme", "need 20 Mi power bank");
    const second = await orderOf("acme");
    await ownerApprove((await pending(second.id)).id);
    const out = await say("acme", "yes");
    assert.match(out[0].text, /same address as last time/);
    assert.match(out[0].text, /12 MG Road/);
    await say("acme", "yes same address");
    assert.equal((await getOrder(second.id)).state, "BILL_PENDING_APPROVAL");
    const inv = (await getInvoice((await getOrder(second.id)).invoice_id!))!;
    assert.equal(inv.payload.buyer.gstin, "27AAACA1234A1Z5");
  });

  test("buyer changes quantity after the quote: hold is resized and a new draft goes to the owner", async () => {
    await say("acme", "need 100 boat smartwatch");
    const order = await orderOf("acme");
    await ownerApprove((await pending(order.id)).id);
    await say("acme", "make it 300 boat smartwatch instead");
    assert.equal((await getOrder(order.id)).state, "QUOTE_PENDING_APPROVAL");
    assert.match((await pending(order.id)).draft_text, /300 pcs/);
    assert.equal(await atp(WATCH), 200);
  });

  test("stock sold directly in Tally: oversold alert, and the bill is blocked", async () => {
    await say("acme", "need 500 boat smartwatch");
    const order = await orderOf("acme");
    await ownerApprove((await pending(order.id)).id);
    await erp.adjustStock(WATCH, -40);
    await sweep();
    const alert = await one<{ message: string }>("SELECT message FROM alerts WHERE kind='oversold'");
    assert.match(alert!.message, /40 more units are promised/);
    await say("acme", "yes");
    await say("acme", DELIVERY);
    const bill = await pending(order.id);
    assert.equal(bill.payload.blocking, true);
    await assert.rejects(ownerApprove(bill.id), /Cannot send this bill/);
    assert.equal((await getOrder(order.id)).state, "BILL_PENDING_APPROVAL");
  });

  test("questions are escalated to the owner, not answered by the bot", async () => {
    await say("acme", "need 10 boat smartwatch");
    await ownerApprove((await pending((await orderOf("acme")).id)).id);
    const out = await say("acme", "What is the warranty on these?");
    assert.match(out[0].text, /check with the team/);
    const alert = await one<{ message: string }>("SELECT message FROM alerts WHERE kind='buyer_question'");
    assert.match(alert!.message, /warranty/);
  });

  test("duplicate webhook deliveries are processed once", async () => {
    const msg = { channel: "simulator", handle: "acme", name: "Acme", text: "need 50 boat smartwatch", externalId: "wa:123" };
    await handleInbound(msg);
    await handleInbound(msg);
    assert.equal(await atp(WATCH), 450);
    assert.equal((await listApprovals("pending")).length, 1);
  });
});

describe("delivery details", () => {
  beforeEach(setup);

  const toDelivery = async (handle: string) => {
    await say(handle, "need 10 boat smartwatch");
    await ownerApprove((await pending((await orderOf(handle)).id)).id);
    await say(handle, "yes");
    return orderOf(handle);
  };

  test("details on separate lines with a city but no pincode: asks only for what is missing", async () => {
    const order = await toDelivery("sinchan");
    // The exact message from the live test that used to loop back to the generic prompt.
    const out = await say("sinchan", "mesa\ngstn dhdiahsdnsd12333n\nbanergatta road , bangalore\nsinchan rai\n8310817359");
    const text = out[0].text;
    assert.doesNotMatch(text, /Please share your delivery and billing details/, "no longer repeats the generic prompt");
    assert.match(text, /noted: mesa · banergatta road, bangalore, Karnataka · sinchan rai, 8310817359/);
    assert.match(text, /Please also share the 6-digit pincode/);
    assert.match(text, /GSTIN "DHDIAHSDNSD12333N" doesn't look right/);
    assert.equal((await getOrder(order.id)).state, "AWAITING_DELIVERY");

    const out2 = await say("sinchan", "560076");
    assert.doesNotMatch(out2[0].text, /pincode/, "pincode accepted");
    assert.match(out2[0].text, /GSTIN/, "still waiting on a valid GSTIN or 'no GST'");

    await say("sinchan", "no GST, we are not registered");
    const o = await getOrder(order.id);
    assert.equal(o.state, "BILL_PENDING_APPROVAL");
    const inv = (await getInvoice(o.invoice_id!))!;
    assert.equal(inv.payload.breakdown.taxMode, "inter", "Karnataka buyer, Maharashtra seller: IGST");
    assert.equal(inv.payload.delivery.pincode, "560076");
    assert.equal(inv.payload.buyer.gstin, null);
  });

  test("a valid GSTIN given later fixes the earlier bad one and sets the state", async () => {
    const order = await toDelivery("priya");
    await say("priya", "Bharat Traders, gst: 29ABCDX, 44 Commercial Street, 560001");
    await say("priya", "GSTIN 29AABCB5678B1Z2");
    const o = await getOrder(order.id);
    assert.equal(o.state, "BILL_PENDING_APPROVAL");
    const inv = (await getInvoice(o.invoice_id!))!;
    assert.equal(inv.payload.buyer.gstin, "29AABCB5678B1Z2");
    assert.equal(inv.payload.delivery.state, "Karnataka");
  });

  test("nothing usable: the buyer sees an example of what to send", async () => {
    await toDelivery("vague");
    const out = await say("vague", "hmm ok will send soon");
    assert.match(out[0].text, /for example/);
  });
});

describe("approval gates", () => {
  beforeEach(setup);

  test("a quote or invoice cannot reach the buyer without an approved approval", async () => {
    await say("acme", "need 10 boat smartwatch");
    const order = await orderOf("acme");
    const buyer = await upsertBuyer("simulator", "acme", null);
    const q = await pending(order.id);
    await assert.rejects(sendToBuyer({ buyer, orderId: order.id, text: "x", kind: "quote" }), ApprovalRequiredError);
    await assert.rejects(sendToBuyer({ buyer, orderId: order.id, text: "x", kind: "quote", approvalId: q.id }), ApprovalRequiredError);
    await assert.rejects(sendToBuyer({ buyer, orderId: order.id, text: "x", kind: "invoice", approvalId: q.id }), ApprovalRequiredError);
  });

  test("every quote and invoice ever sent has an approved approval for the same order", async () => {
    await say("a", "need 10 boat smartwatch");
    await ownerApprove((await pending((await orderOf("a")).id)).id);
    await say("a", "yes");
    await say("a", DELIVERY);
    await ownerApprove((await pending((await orderOf("a")).id)).id);
    const sent = await all<{ kind: string; status: string; same: boolean }>(
      `SELECT m.kind, a.status, a.order_id = m.order_id AS same FROM messages m LEFT JOIN approvals a ON a.id = m.approval_id WHERE m.kind IN ('quote','invoice')`,
    );
    assert.equal(sent.length, 2);
    for (const s of sent) {
      assert.equal(s.status, "approved");
      assert.equal(s.same, true);
    }
  });

  test("approving a draft twice is refused", async () => {
    await say("acme", "need 10 boat smartwatch");
    const q = await pending((await orderOf("acme")).id);
    await ownerApprove(q.id);
    await assert.rejects(ownerApprove(q.id), /already approved/);
  });
});
