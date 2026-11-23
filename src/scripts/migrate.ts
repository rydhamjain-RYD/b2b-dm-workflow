// Creates the tables (if missing), locks them down for Supabase, and loads the seed
// catalog if the database is empty. Safe to run repeatedly: `npm run db:migrate`.
import { openDb, closeDb } from "../db.ts";
import { settings } from "../config.ts";
import { seedIfEmpty } from "../app.ts";

if (!settings.databaseUrl) {
  console.error("Set DATABASE_URL (e.g. in .env) to the Supabase connection string first.");
  process.exit(1);
}
await openDb(settings.databaseUrl);
await seedIfEmpty();
await closeDb();
console.log("Database ready.");
