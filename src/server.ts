// Local server: `npm start`. Uses Supabase if DATABASE_URL is set, otherwise an
// embedded Postgres stored in data/pglite.
import { settings } from "./config.ts";
import { openDb } from "./db.ts";
import { assistant } from "./ai/index.ts";
import { erp } from "./erp/mockTally.ts";
import { whatsappEnabled } from "./channels/whatsapp.ts";
import { sweep } from "./orders/service.ts";
import { createApp, seedIfEmpty } from "./app.ts";

await openDb(settings.databaseUrl || settings.localDbDir);
await seedIfEmpty();
const host = process.env.HOST || "127.0.0.1";
createApp().listen(settings.port, host, () => {
  console.log(`B2B DM workflow running at http://localhost:${settings.port}`);
  console.log(`  database: ${settings.databaseUrl ? "Postgres (DATABASE_URL)" : "embedded Postgres in data/pglite"}`);
  console.log(`  assistant: ${assistant().mode === "claude" ? "Claude (claude-opus-5-5)" : "built-in rules (set ANTHROPIC_API_KEY to use Claude)"}`);
  console.log(`  ERP: ${erp.name}   WhatsApp: ${whatsappEnabled() ? "enabled" : "off (using simulator)"}`);
  console.log(`  password: ${process.env.APP_PASSWORD ? "required" : "none (set APP_PASSWORD to require one)"}`);
});
setInterval(() => {
  sweep().catch((err) => console.error("[sweep]", err));
}, settings.sweepIntervalMs);
