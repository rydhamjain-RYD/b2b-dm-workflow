import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, makeOrders, setStock } from "./helpers.ts";
import { one, dbKind } from "../src/db.ts";
import { advanceClock } from "../src/clock.ts";
import {
  atp, reserve, moveHolds, releaseOrder, sweepExpired, reservationsFor, oversold,
} from "../src/inventory/ledger.ts";
import { erp, syncFromErp } from "../src/erp/mockTally.ts";

const SKU = "SW-BOAT-XTEND"; // 500 in stock in the seed

describe("inventory ledger", () => {
  beforeEach(freshDb);

  test("three buyers want 500 of a 500-unit SKU: exactly one gets it", async () => {
    const [a, b, c] = await makeOrders(3);
    const ra = await reserve(a, SKU, 500, 60_000);
    const rb = await reserve(b, SKU, 500, 60_000);
    const rc = await reserve(c, SKU, 300, 60_000);
    assert.equal(ra.reserved, 500);
    assert.equal(rb.reserved, 0);
    assert.equal(rb.shortfall, 500);
    assert.equal(rc.reserved, 0);
    assert.equal(await atp(SKU), 0);
  });

  test("partial availability reserves what is left", async () => {
    const [a, b] = await makeOrders(2);
    await reserve(a, SKU, 350, 60_000);
    const rb = await reserve(b, SKU, 300, 60_000);
    assert.equal(rb.reserved, 150);
    assert.equal(rb.shortfall, 150);
  });

  test("retrying the same reservation is idempotent (duplicate webhook)", async () => {
    const [a] = await makeOrders(1);
    await reserve(a, SKU, 200, 60_000);
    await reserve(a, SKU, 200, 60_000);
    await reserve(a, SKU, 200, 60_000);
    assert.equal(await atp(SKU), 300);
    assert.equal((await reservationsFor(a)).length, 1);
  });

  test("buyer changes quantity: the hold is resized, not stacked", async () => {
    const [a] = await makeOrders(1);
    await reserve(a, SKU, 200, 60_000);
    await reserve(a, SKU, 450, 60_000);
    assert.equal(await atp(SKU), 50);
  });

  test("an expired hold stops counting immediately, before any sweep", async () => {
    const [a, b] = await makeOrders(2);
    await reserve(a, SKU, 500, 60_000);
    advanceClock(61_000);
    assert.equal(await atp(SKU), 500);
    assert.equal((await reserve(b, SKU, 500, 60_000)).reserved, 500);
    // a's lapsed hold cannot be revived because b now holds the stock
    assert.deepEqual(await moveHolds(a, "QUOTED_HOLD", 60_000), [{ sku: SKU, wanted: 500, held: 0 }]);
    assert.equal((await sweepExpired()).length, 0); // a was already released by moveHolds
  });

  test("sweeper releases lapsed holds and returns them", async () => {
    const [a] = await makeOrders(1);
    await reserve(a, SKU, 100, 1_000);
    advanceClock(2_000);
    assert.equal((await sweepExpired()).length, 1);
    assert.equal((await reservationsFor(a))[0].state, "RELEASED");
  });

  test("commit and release lifecycle", async () => {
    const [a, b] = await makeOrders(2);
    await reserve(a, SKU, 300, 60_000);
    await moveHolds(a, "COMMITTED", null);
    advanceClock(10 * 60_000);
    assert.equal(await atp(SKU), 200, "committed stock never expires");
    await reserve(b, SKU, 200, 60_000);
    await releaseOrder(b, "buyer_declined");
    assert.equal(await atp(SKU), 200);
  });

  test("stock sold directly in Tally shows up as oversold", async () => {
    const [a] = await makeOrders(1);
    await reserve(a, SKU, 500, 60_000);
    await erp.adjustStock(SKU, -40);
    await syncFromErp();
    assert.deepEqual(await oversold(), [{ sku: SKU, over: 40 }]);
  });

  for (const n of [3, 10, 50]) {
    test(`${n} simultaneous requests for 120 units each never oversell (${process.env.TEST_DATABASE_URL ? "real Postgres, pooled connections" : "embedded Postgres"})`, async () => {
      await setStock(SKU, 500);
      const ids = await makeOrders(n);
      const results = await Promise.all(ids.map((id) => reserve(id, SKU, 120, 60_000)));
      const total = results.reduce((s, r) => s + r.reserved, 0);
      const expected = Math.min(500, n * 120);
      assert.equal(total, expected, "sum of reservations equals what was available");
      const db = await one<{ q: number }>("SELECT COALESCE(SUM(qty),0)::int AS q FROM reservations WHERE sku=$1 AND state='DRAFT_HOLD'", SKU);
      assert.equal(db!.q, expected);
      assert.equal(await atp(SKU), 500 - expected);
      if (dbKind() === "pg") console.log(`    ${n} concurrent reservations on real Postgres: ${total} units held of 500`);
    });
  }
});
