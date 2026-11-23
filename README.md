# B2B DM Workflow

An AI sales assistant for B2B businesses that get 50–100+ DMs a day. It reads each buyer message, checks stock, prices the order with your own rules, and drafts the reply. **Nothing that commits you (a quote or a bill) reaches a buyer until you approve it.**

```
Buyer DM ─► AI reads the requirement ─► stock reserved ─► priced by your rules ─► quote drafted
        ─► YOU APPROVE ─► buyer confirms ─► delivery details ─► bill drafted in Tally
        ─► YOU APPROVE ─► invoice sent ─► buyer saved for next time
```

## Run it

Needs Node 24+.

```powershell
npm install
npm start
```

Open http://localhost:3000. The demo page shows buyers chatting on the left and the owner dashboard on the right. Without a `DATABASE_URL` it uses an embedded Postgres stored in `data/pglite`, so nothing else needs installing.

Try this:
1. As Ravi, send "Hi, we have a requirement", then "We need 500 boAt smartwatches".
2. Switch to Priya and send "need 300 boat smartwatch". Only 500 exist and Ravi holds them, so Priya's draft says *out of stock, waitlisted*.
3. In **Approvals**, approve both. Ravi replies "Yes, go ahead", then sends his delivery details (use the suggestion chip).
4. Optional: type a discount in **Extra discount** and click **Apply discount**. The draft is re-priced so you see the new total before sending.
5. Approve the bill. Ravi gets the invoice link, and Tally stock drops by 500.
6. In **Inventory**, add +300 to boAt Xtend "in Tally". Priya automatically gets a "back in stock" quote drafted for you.

Other commands: `npm test` (58 tests), `npm run typecheck`, `npm run reset` (wipe demo data).

## Claude or built-in rules

Without a key, a rule-based reader handles clear messages ("need 500 boAt smartwatches", "yes", a typical address). To use Claude (`claude-opus-5-5`) for any phrasing, including Hindi and Hinglish, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. If Claude ever fails, the app falls back to the rules automatically.

Claude only **reads** messages and **writes wording**. Quantities, prices, discounts, tax and totals always come from code: wording that contains any digit is thrown away.

## How the hard problems are solved

**Several DMs for the same product at once** ([src/inventory/ledger.ts](src/inventory/ledger.ts))
Chats never read raw Tally stock. They read *available to promise* = Tally stock − committed − live holds, and take stock with an atomic reservation: the product row is locked (`SELECT … FOR UPDATE`) inside a Postgres transaction. Concurrent requests for a SKU, even from different server instances, queue on that lock, so promises can never exceed stock. Tested with 50 simultaneous requests (`TEST_DATABASE_URL=… npm test` runs it on real Postgres with pooled connections; that database is wiped). Holds expire (2 h while waiting for you, 24 h after the quote is sent). Freed stock goes to the waitlist first-come-first-served. If stock is sold directly in Tally, you get an *oversold* alert, and the bill is blocked.

**Your calculation rules** ([data/seed/pricing-rules.json](data/seed/pricing-rules.json), [src/pricing/engine.ts](src/pricing/engine.ts))
Rules are applied in a fixed order: quantity slabs → buyer contract price → line discount → order-value discount (+ any extra % you grant) → GST per product (CGST+SGST in-state, IGST out of state) → round off. The bill discount can be set before or after tax. Money is computed in paise, so totals never drift. Every quote and invoice records the rule version and shows the step-by-step calculation. Before a bill is sent, the total is cross-checked against Tally.

**The AI can't skip steps** ([src/orders/stateMachine.ts](src/orders/stateMachine.ts), [src/channels/index.ts](src/channels/index.ts))
The order flow is a state machine in code. The send function refuses to send a quote or invoice unless an owner-approved approval exists for that order.

## Owner controls

- **Change the price.** Every quote and bill card has an editable unit price per item. Click **Apply changes** to re-price; the bill uses the same prices. "use normal price" undoes it.
- **Discounts.** Add an extra % on the whole bill, or tick **Remove all discounts** (the automatic order-value and product discounts and your extra %) so the buyer pays the plain price. Bulk-slab prices and your own prices still apply.
- **Approve is blocked while changes are unapplied**, so a bill never goes out with numbers you didn't see.
- **Negotiation (new buyers only).** When a new buyer bargains ("too costly", "can you do 1750", "kuch kam karo"), the assistant drafts a counter-offer the way an Indian wholesaler would: 1.5%, then 3%, then a firm final 5%. If the buyer names a number inside the next step, it meets them there. Every counter-offer waits for your approval, and you can change its % first. Returning buyers who bargain are handed to you with no automatic concession. Limits live in `data/seed/pricing-rules.json` → `negotiation` (per-product caps too).
- **Dispatch.** The **Dispatch** tab lists billed orders. Enter the transporter, vehicle number (validated, e.g. MH12AB1234 or 22BH1234AA), LR/docket, e-way bill, driver and expected date. The buyer gets them on chat, they print on the invoice, and "where is my order?" is answered automatically. Then mark the order **Delivered**.

## What's real and what's simulated in v1

| Part | Status |
|---|---|
| Inventory ledger, reservations, expiry, waitlist | Real |
| Pricing/GST rules engine, invoice | Real |
| Order flow, both approval gates, redraft on reject | Real |
| AI reading and wording | Claude when configured, rules otherwise |
| Tally | **Mock** ([src/erp/mockTally.ts](src/erp/mockTally.ts)) behind an `ErpConnector` interface. The next step is a real Tally Prime connector (XML over HTTP via a small agent on the Tally PC) |
| WhatsApp | Cloud API adapter + webhook written (`/webhooks/whatsapp`), off until `WHATSAPP_*` is set. Messages after the 24-hour window need approved templates (not wired yet) |
| Instagram, email | Not yet; they plug into the same `handleInbound()` |
| Access | One shared password (`APP_PASSWORD`) for the dashboard and simulator. Buyers open invoices through unguessable `/i/<token>` links |

## Deploy: Supabase + Vercel

1. **Supabase.** Copy the *Transaction pooler* connection string (dashboard → Connect) into `.env` as `DATABASE_URL`, with your database password filled in. Then set `APP_PASSWORD`.
2. `npm run db:migrate` creates the tables and loads the catalog. Tables get row-level security with no policies, so Supabase's public REST API (and the publishable key) cannot read them. Only this server can.
3. **Vercel.** Run `npx vercel login` once, then:
   ```powershell
   npm run build:vercel
   npx vercel deploy --prebuilt --prod
   ```
   In the Vercel project settings, set `DATABASE_URL`, `APP_PASSWORD` and optionally `ANTHROPIC_API_KEY`. Set `VERCEL_REGION` before building to match your Supabase region (default `bom1`, Mumbai).

On Vercel there is no always-on process. Expired holds, waitlist offers and the Tally resync run at most every 30 seconds, triggered when someone uses the dashboard or simulator. Stock correctness never depends on this, because expired holds stop counting immediately.

## Layout

```
src/
  inventory/ledger.ts     ATP, atomic reservations, expiry, waitlist
  pricing/engine.ts       rules engine (slabs, discounts, GST, rounding)
  orders/service.ts       the conversation flow
  orders/stateMachine.ts  allowed steps
  app.ts / server.ts      HTTP app; local server
  vercel.ts               serverless entry (bundled by scripts/build-vercel.mjs)
  db.ts                   Postgres (Supabase) or embedded PGlite, transactions, locks
  orders/matcher.ts       buyer text -> catalog SKU (asks when ambiguous)
  ai/                     Claude assistant + rule-based fallback
  erp/                    ErpConnector + MockTally
  channels/               approval-gated sending, WhatsApp adapter
  invoices/               invoice records + printable HTML
public/                   owner dashboard, buyer simulator, demo page
data/seed/                catalog (mock Tally), business profile, pricing rules
test/                     ledger concurrency, pricing, end-to-end flows, gates
```
