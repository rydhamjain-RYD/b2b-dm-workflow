// Builds .vercel/output (Vercel Build Output API v3):
//   static/                 the pages in public/ (served from Vercel's CDN)
//   functions/index.func/   the whole API bundled into one Node.js function
// Deploy with: npx vercel deploy --prebuilt --prod
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".vercel", "output");
const fn = path.join(out, "functions", "index.func");
// Vercel region for the function; put it next to the Supabase database (e.g. bom1 for ap-south-1).
const region = process.env.VERCEL_REGION || "bom1";

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "vercel.ts")],
  outfile: path.join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  // PGlite is only for local dev/tests; pg-native is an optional pg add-on we don't use.
  external: ["@electric-sql/pglite", "pg-native"],
  // Bundled CommonJS packages (express, pg) call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "info",
});

writeFileSync(path.join(fn, ".vc-config.json"), JSON.stringify({
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
  regions: [region],
}, null, 2));

cpSync(path.join(root, "public"), path.join(out, "static"), { recursive: true });

writeFileSync(path.join(out, "config.json"), JSON.stringify({
  version: 3,
  routes: [
    { src: "/(.*)", headers: { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" }, continue: true },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index" },
  ],
}, null, 2));

console.log(`Built ${path.relative(root, out)} (function region ${region})`);
