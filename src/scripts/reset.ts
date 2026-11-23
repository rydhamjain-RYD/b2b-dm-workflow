// Wipes the database (local or DATABASE_URL) and reloads the seed catalog (mock Tally stock).
import { openDb, wipeAll, closeDb } from "../db.ts";
import { settings } from "../config.ts";
import { seedIfEmpty } from "../app.ts";

await openDb(settings.databaseUrl || settings.localDbDir);
await wipeAll();
await seedIfEmpty();
await closeDb();
console.log(`Database reset (${settings.databaseUrl ? "DATABASE_URL" : settings.localDbDir})`);
