import { openDb, wipeAll, one } from "../src/db.ts";
import { erp, syncFromErp } from "../src/erp/mockTally.ts";
import { resetClock } from "../src/clock.ts";
import { seedIfEmpty } from "../src/app.ts";

let opened = false;

/**
 * Empty, seeded database. Uses an in-memory Postgres (PGlite), or a real Postgres when
 * TEST_DATABASE_URL is set. WARNING: that database is wiped before every test.
 */
export async function freshDb(): Promise<void> {
  if (!opened) {
    await openDb(process.env.TEST_DATABASE_URL || "");
    opened = true;
  }
  resetClock();
  await wipeAll();
  await seedIfEmpty();
}

export async function makeOrders(n: number): Promise<number[]> {
  const buyer = await one<{ id: number }>(
    "INSERT INTO buyers (channel, handle, name, created_at) VALUES ('test', $1, 'Test', 0) RETURNING id",
    `t-${Math.random()}`,
  );
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = await one<{ id: number }>(
      "INSERT INTO orders (buyer_id, channel, state, created_at, updated_at) VALUES ($1, 'test', 'AWAITING_REQUIREMENT', 0, 0) RETURNING id",
      buyer!.id,
    );
    ids.push(row!.id);
  }
  return ids;
}

export async function setStock(sku: string, qty: number): Promise<void> {
  await erp.adjustStock(sku, -1_000_000);
  await erp.adjustStock(sku, qty);
  await syncFromErp();
}
