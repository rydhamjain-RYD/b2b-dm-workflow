// Vercel serverless entry. Bundled by scripts/build-vercel.mjs into .vercel/output.
import type { IncomingMessage, ServerResponse } from "node:http";
import { openDb } from "./db.ts";
import { settings } from "./config.ts";
import { createApp, seedIfEmpty } from "./app.ts";

if (!settings.databaseUrl) throw new Error("DATABASE_URL is not set");
// Runs once per cold start; migrations are idempotent and serialized with an advisory lock.
const ready = openDb(settings.databaseUrl).then(seedIfEmpty);
const app = createApp();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await ready;
  app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
