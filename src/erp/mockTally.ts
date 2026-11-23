/**
 * MockTally: stands in for Tally's books so the whole flow runs without a real Tally.
 * Stored in its own tables (erp_items, erp_vouchers) so it behaves like a separate
 * system: our products table only changes when we sync from it.
 */
import { randomUUID } from "node:crypto";
import { all, json, one, run, tx } from "../db.ts";
import { now } from "../clock.ts";
import { loadBusiness } from "../config.ts";
import catalogJson from "../../data/seed/catalog.json" with { type: "json" };
import type { ErpConnector, ErpItem, VoucherDraft } from "./connector.ts";

export class MockTally implements ErpConnector {
  readonly name = "MockTally";

  async seedFromCatalog(): Promise<void> {
    await tx(async () => {
      for (const it of (catalogJson as { items: ErpItem[] }).items) {
        await run(
          `INSERT INTO erp_items (sku, data, closing_qty) VALUES ($1, $2, $3)
           ON CONFLICT (sku) DO UPDATE SET data = EXCLUDED.data, closing_qty = EXCLUDED.closing_qty`,
          it.sku, JSON.stringify(it), it.onHand,
        );
      }
    });
  }

  async listItems(): Promise<ErpItem[]> {
    const rows = await all<{ data: unknown; closing_qty: number }>("SELECT data, closing_qty FROM erp_items ORDER BY sku");
    return rows.map((r) => ({ ...json.parse<ErpItem>(r.data, {} as ErpItem), onHand: r.closing_qty }));
  }

  /** Simulates a sale or purchase entered directly in Tally (outside this system). */
  async adjustStock(sku: string, delta: number): Promise<number> {
    const row = await one<{ closing_qty: number }>(
      "UPDATE erp_items SET closing_qty = GREATEST(0, closing_qty + $1) WHERE sku = $2 RETURNING closing_qty",
      delta, sku,
    );
    if (!row) throw new Error(`Unknown SKU ${sku}`);
    return row.closing_qty;
  }

  async createSalesVoucherDraft(draft: VoucherDraft): Promise<{ voucherId: string; number: string }> {
    const seq = await one<{ n: number }>("SELECT nextval('erp_voucher_seq')::int AS n");
    const number = `${loadBusiness().invoicePrefix}${String(seq!.n).padStart(4, "0")}`;
    const voucherId = randomUUID();
    await run(
      "INSERT INTO erp_vouchers (id, number, status, data, created_at) VALUES ($1, $2, 'draft', $3, $4)",
      voucherId, number, JSON.stringify(draft), now(),
    );
    return { voucherId, number };
  }

  async postVoucher(voucherId: string): Promise<void> {
    await tx(async () => {
      const v = await one<{ status: string; data: unknown }>("SELECT status, data FROM erp_vouchers WHERE id=$1 FOR UPDATE", voucherId);
      if (!v) throw new Error(`Unknown voucher ${voucherId}`);
      if (v.status === "posted") return;
      if (v.status !== "draft") throw new Error(`Voucher ${voucherId} is ${v.status}`);
      const draft = json.parse<VoucherDraft>(v.data, { lines: [] } as unknown as VoucherDraft);
      for (const line of [...draft.lines].sort((a, b) => a.sku.localeCompare(b.sku))) {
        const row = await one<{ closing_qty: number }>("SELECT closing_qty FROM erp_items WHERE sku=$1 FOR UPDATE", line.sku);
        if (!row || row.closing_qty < line.qty) {
          throw new Error(`Tally stock for ${line.sku} is ${row?.closing_qty ?? 0}, voucher needs ${line.qty}`);
        }
        await run("UPDATE erp_items SET closing_qty = closing_qty - $1 WHERE sku=$2", line.qty, line.sku);
      }
      await run("UPDATE erp_vouchers SET status='posted' WHERE id=$1", voucherId);
    });
  }

  async cancelVoucher(voucherId: string): Promise<void> {
    await run("UPDATE erp_vouchers SET status='cancelled' WHERE id=$1 AND status='draft'", voucherId);
  }

  async computeVoucherTotal(voucherId: string): Promise<number> {
    const v = await one<{ data: unknown }>("SELECT data FROM erp_vouchers WHERE id=$1", voucherId);
    if (!v) throw new Error(`Unknown voucher ${voucherId}`);
    const draft = json.parse<VoucherDraft>(v.data, { lines: [] } as unknown as VoucherDraft);
    const lineSum = draft.lines.reduce((s, l) => s + l.taxable + l.tax, 0);
    return Math.round((lineSum + (draft.adjustments ?? 0)) * 100) / 100;
  }
}

export const erp = new MockTally();

/** Pull master data + closing stock from the ERP into our products table. */
export async function syncFromErp(connector: ErpConnector = erp): Promise<{ changed: { sku: string; from: number; to: number }[] }> {
  const items = await connector.listItems();
  return tx(async () => {
    const t = now();
    const changed: { sku: string; from: number; to: number }[] = [];
    for (const it of items) {
      const prev = await one<{ on_hand: number }>("SELECT on_hand FROM products WHERE sku=$1", it.sku);
      if (prev && prev.on_hand === it.onHand) continue;
      if (prev) changed.push({ sku: it.sku, from: prev.on_hand, to: it.onHand });
      await run(
        `INSERT INTO products (sku, name, brand, category, aliases, unit, unit_price, gst_rate, hsn, on_hand, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (sku) DO UPDATE SET name=EXCLUDED.name, brand=EXCLUDED.brand, category=EXCLUDED.category,
           aliases=EXCLUDED.aliases, unit=EXCLUDED.unit, unit_price=EXCLUDED.unit_price, gst_rate=EXCLUDED.gst_rate,
           hsn=EXCLUDED.hsn, on_hand=EXCLUDED.on_hand, synced_at=EXCLUDED.synced_at`,
        it.sku, it.name, it.brand, it.category, JSON.stringify(it.aliases), it.unit, it.unitPrice, it.gstRate, it.hsn, it.onHand, t,
      );
    }
    await run("UPDATE products SET synced_at=$1", t);
    return { changed };
  });
}
