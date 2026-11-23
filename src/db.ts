/**
 * Postgres access. Production uses Supabase through `pg` (DATABASE_URL). Local dev
 * and tests use PGlite, a real Postgres compiled to WebAssembly, so the SQL, the
 * row locks and the transactions are the same everywhere.
 *
 * tx() runs a callback inside one transaction; queries made anywhere inside it
 * (even in other modules) join that transaction automatically.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { now } from "./clock.ts";

export type Row = Record<string, unknown>;

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}

interface Driver extends Queryable {
  kind: "pg" | "pglite";
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (c: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

let driver: Driver | null = null;
const txClient = new AsyncLocalStorage<Queryable>();

async function pgDriver(url: string): Promise<Driver> {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(20, (v: string) => Number(v)); // int8 (timestamps, counts)
  pg.types.setTypeParser(1700, (v: string) => Number(v)); // numeric
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX) || 5,
    // Supabase requires TLS; its pooler certificate is not in Node's default CA list.
    ssl: local ? undefined : { rejectUnauthorized: false },
  });
  return {
    kind: "pg",
    query: (sql, params) => pool.query(sql, params as unknown[]),
    exec: async (sql) => {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDriver(dataDir: string | undefined): Promise<Driver> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir, {
    parsers: { [types.INT8]: (v: string) => Number(v), [types.NUMERIC]: (v: string) => Number(v) },
  });
  return {
    kind: "pglite",
    query: (sql, params) => db.query(sql, params as unknown[]) as Promise<{ rows: Row[] }>,
    exec: async (sql) => {
      await db.exec(sql);
    },
    transaction: (fn) => db.transaction((t) => fn(t as unknown as Queryable)),
    close: () => db.close(),
  };
}

/** Open the database: Postgres URL, a PGlite data directory, or in-memory when empty. */
export async function openDb(target: string): Promise<void> {
  if (driver) await driver.close();
  driver = /^postgres(ql)?:\/\//.test(target) ? await pgDriver(target) : await pgliteDriver(target || undefined);
  await migrate();
}

export async function closeDb(): Promise<void> {
  await driver?.close();
  driver = null;
}

export function dbKind(): "pg" | "pglite" | null {
  return driver?.kind ?? null;
}

function client(): Queryable {
  const c = txClient.getStore();
  if (c) return c;
  if (!driver) throw new Error("Database not opened. Call openDb() first.");
  return driver;
}

export async function all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (await client().query(sql, params)).rows as T[];
}

export async function one<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  return (await all<T>(sql, ...params))[0];
}

export async function run(sql: string, ...params: unknown[]): Promise<void> {
  await client().query(sql, params);
}

/** Run fn in a transaction. Nested calls join the outer one. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return fn();
  if (!driver) throw new Error("Database not opened. Call openDb() first.");
  return driver.transaction((c) => txClient.run(c, fn));
}

export function inTx(): boolean {
  return Boolean(txClient.getStore());
}

/** JSON columns come back parsed from Postgres; tolerate strings too. */
export const json = {
  parse<T>(v: unknown, fallback: T): T {
    if (v === null || v === undefined || v === "") return fallback;
    if (typeof v !== "string") return v as T;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
};

// ---------- cross-instance lock (serverless functions do not share memory) ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A lease lock in a table, so two serverless instances never process the same buyer
 * at the same time. Must not be called inside tx() (the lock row has to be visible
 * to other connections immediately).
 */
export async function withDbLock<T>(key: string, fn: () => Promise<T>, leaseMs = 120_000): Promise<T> {
  if (inTx()) throw new Error("withDbLock cannot run inside a transaction");
  const token = randomUUID();
  const give_up = Date.now() + 60_000;
  for (;;) {
    const t = now();
    const got = await one(
      `INSERT INTO locks (key, token, until) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET token = EXCLUDED.token, until = EXCLUDED.until
       WHERE locks.until < $4 RETURNING key`,
      key, token, t + leaseMs, t,
    );
    if (got) break;
    if (Date.now() > give_up) throw new Error("This conversation is busy, please try again");
    await sleep(80 + Math.random() * 120);
  }
  try {
    return await fn();
  } finally {
    await run("DELETE FROM locks WHERE key = $1 AND token = $2", key, token);
  }
}

// ---------- schema ----------

const SCHEMA = `
-- Our view of products. on_hand is synced from the ERP (Tally). Conversations do NOT
-- read it directly; they read available-to-promise (see inventory/ledger.ts).
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT NOT NULL,
  category TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]',
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_price DOUBLE PRECISION NOT NULL,
  gst_rate DOUBLE PRECISION NOT NULL,
  hsn TEXT,
  on_hand INTEGER NOT NULL,
  synced_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS buyers (
  id SERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  handle TEXT NOT NULL,
  name TEXT,
  business_name TEXT,
  gstin TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (channel, handle)
);

CREATE TABLE IF NOT EXISTS addresses (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  contact_name TEXT,
  phone TEXT,
  line TEXT NOT NULL,
  city TEXT,
  state TEXT NOT NULL,
  pincode TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  channel TEXT NOT NULL,
  state TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'dm',
  lines JSONB NOT NULL DEFAULT '[]',
  pending JSONB NOT NULL DEFAULT '[]',
  quote JSONB,
  quote_version INTEGER NOT NULL DEFAULT 0,
  extra_discount_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  delivery JSONB,
  invoice_id INTEGER,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
-- Added after v1; ALTERs keep existing databases working.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_overrides JSONB NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS waive_discounts BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS negotiation JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch JSONB;

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER NOT NULL REFERENCES buyers(id),
  order_id INTEGER,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL DEFAULT 'chat',
  text TEXT NOT NULL,
  approval_id INTEGER,
  external_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_external ON messages(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_buyer ON messages(buyer_id, id);

CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  gate TEXT NOT NULL CHECK (gate IN ('quote','bill')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
  draft_text TEXT NOT NULL,
  sent_text TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  owner_note TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);

-- The inventory ledger. One row per (order, sku). Live states count against ATP.
CREATE TABLE IF NOT EXISTS reservations (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  sku TEXT NOT NULL REFERENCES products(sku),
  qty INTEGER NOT NULL CHECK (qty > 0),
  state TEXT NOT NULL CHECK (state IN ('DRAFT_HOLD','QUOTED_HOLD','COMMITTED','BILLED','RELEASED')),
  expires_at BIGINT,
  release_reason TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (order_id, sku)
);
CREATE INDEX IF NOT EXISTS reservations_sku_state ON reservations(sku, state);

CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','offered','cancelled')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  erp_voucher_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','final','cancelled')),
  public_token TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  ref TEXT,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id SERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  ref TEXT,
  detail JSONB
);

CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  until BIGINT NOT NULL
);

-- Stand-in for Tally's own books (a separate system reached only through the connector).
CREATE TABLE IF NOT EXISTS erp_items (
  sku TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  closing_qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS erp_vouchers (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS erp_voucher_seq;
`;

export const TABLES = [
  "products", "buyers", "addresses", "orders", "messages", "approvals", "reservations", "waitlist",
  "invoices", "alerts", "audit", "locks", "erp_items", "erp_vouchers",
];

// On Supabase, tables in "public" are reachable through its REST API with the public
// (publishable) key. Turn on row-level security with no policies and revoke access, so
// only this server (connecting as the database owner) can read or write them.
const LOCK_DOWN = `
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    FOREACH t IN ARRAY ARRAY[${TABLES.map((t) => `'${t}'`).join(",")}] LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon, authenticated', t);
    END LOOP;
    REVOKE ALL ON SEQUENCE erp_voucher_seq FROM anon, authenticated;
  END IF;
END $$;
`;

async function migrate(): Promise<void> {
  await driver!.transaction(async (c) => {
    // Several cold-starting serverless instances may migrate at once; take turns.
    await c.query("SELECT pg_advisory_xact_lock(727274)");
    for (const stmt of SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await c.query(stmt);
    }
    await c.query(LOCK_DOWN);
  });
}

/** Delete all data (demo reset / tests). */
export async function wipeAll(): Promise<void> {
  await run(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  await run("ALTER SEQUENCE erp_voucher_seq RESTART WITH 1");
}
