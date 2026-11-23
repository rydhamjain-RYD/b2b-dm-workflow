import { fileURLToPath } from "node:url";
import path from "node:path";
// Seed data is imported (not read from disk) so it is bundled into the serverless function.
import businessJson from "../data/seed/business.json" with { type: "json" };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Business {
  name: string;
  gstin: string;
  state: string;
  address: string;
  phone: string;
  invoicePrefix: string;
  bank: string;
  paymentTerms: string;
  replyTone: string;
}

export function loadBusiness(): Business {
  return businessJson as Business;
}

function minutes(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

/**
 * Public demo: deployed (on Vercel) without a DATABASE_URL. Runs an in-memory database
 * with the sample catalog; data resets whenever the server restarts. No password needed.
 * Adding DATABASE_URL (and APP_PASSWORD) switches to the real, permanent setup.
 */
export const isDemo = (): boolean => Boolean(process.env.VERCEL) && !process.env.DATABASE_URL;

export const settings = {
  port: Number(process.env.PORT) || 3000,
  /** Postgres URL (Supabase) in production. Empty = embedded Postgres (PGlite) stored in data/pglite. */
  get databaseUrl(): string {
    return process.env.DATABASE_URL || "";
  },
  localDbDir: path.join(ROOT, "data", "pglite"),
  draftHoldMs: minutes("DRAFT_HOLD_MINUTES", 120) * 60_000,
  quotedHoldMs: minutes("QUOTED_HOLD_MINUTES", 1440) * 60_000,
  sweepIntervalMs: 30_000,
  get publicUrl(): string {
    const explicit = process.env.PUBLIC_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    return `http://localhost:${this.port}`;
  },
};
