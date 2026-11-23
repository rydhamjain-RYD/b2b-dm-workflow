// Vercel serverless entry. Bundled by scripts/build-vercel.mjs into .vercel/output.
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDb } from "./db.ts";
import { settings, isDemo } from "./config.ts";
import { createApp, seedIfEmpty } from "./app.ts";

// With DATABASE_URL: Supabase Postgres. Without it: public demo on an in-memory
// database ("" = PGlite in memory) that starts fresh with the sample catalog.
// Runs once per cold start; migrations are idempotent and serialized with an advisory lock.
const ready = openDb(settings.databaseUrl).then(seedIfEmpty);
if (isDemo()) console.log("[demo] no DATABASE_URL: running on a temporary in-memory database");
const app = createApp();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ready;
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
