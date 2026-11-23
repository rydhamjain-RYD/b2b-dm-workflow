/**
 * The only way the workflow talks to the accounting/inventory system.
 * v1 ships MockTally. A real Tally Prime connector (XML over HTTP via an
 * on-prem agent) or Zoho Inventory (REST) implements this same interface.
 */
export interface ErpItem {
  sku: string;
  name: string;
  brand: string;
  category: string;
  aliases: string[];
  unit: string;
  unitPrice: number;
  gstRate: number;
  hsn: string;
  onHand: number;
}

export interface VoucherLine {
  sku: string;
  qty: number;
  rate: number;
  taxable: number;
  tax: number;
}

export interface VoucherDraft {
  orderId: number;
  buyerName: string;
  buyerGstin: string | null;
  placeOfSupply: string;
  lines: VoucherLine[];
  /** Post-tax discount and round-off ledger entries (negative or positive). */
  adjustments: number;
  grandTotal: number;
}

export interface ErpConnector {
  readonly name: string;
  listItems(): Promise<ErpItem[]>;
  /** Creates an unposted sales voucher; stock is not touched yet. */
  createSalesVoucherDraft(draft: VoucherDraft): Promise<{ voucherId: string; number: string }>;
  /** Posts the voucher: stock goes down in the ERP. Idempotent. */
  postVoucher(voucherId: string): Promise<void>;
  cancelVoucher(voucherId: string): Promise<void>;
  /** Recalculate a total the way the ERP would, to cross-check our engine. */
  computeVoucherTotal(voucherId: string): Promise<number>;
}
