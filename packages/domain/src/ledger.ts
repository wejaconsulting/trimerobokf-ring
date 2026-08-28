import { z } from 'zod';
import { accountTypeSchema } from './enums.js';
import { isoDateSchema } from './period.js';

/**
 * Normalised, read-only copies of Fortnox accounting data.
 *
 * Fortnox remains the source of truth. These shapes exist so the rules engine
 * can reason about the ledger without coupling to the wire format of any one
 * Fortnox endpoint, and so a future adapter can map a different upstream.
 */

export const accountSchema = z.object({
  number: z.number().int().min(1000).max(9999),
  description: z.string(),
  type: accountTypeSchema,
  active: z.boolean(),
  /** Fortnox VAT code, e.g. 'MP1', 'I25'. Free text on purpose - it is upstream data. */
  vatCode: z.string().nullable(),
  /** BAS: does this account require a cost center in this client's chart? */
  costCenterRequired: z.boolean().default(false),
  projectRequired: z.boolean().default(false),
});
export type Account = z.infer<typeof accountSchema>;

export function accountTypeFromNumber(n: number): z.infer<typeof accountTypeSchema> {
  // Swedish BAS chart of accounts class ranges.
  if (n >= 1000 && n <= 1999) return 'asset';
  if (n >= 2000 && n <= 2099) return 'equity';
  if (n >= 2100 && n <= 2999) return 'liability';
  if (n >= 3000 && n <= 3999) return 'revenue';
  return 'cost';
}

export function isResultAccount(n: number): boolean {
  return n >= 3000;
}

export function isBalanceAccount(n: number): boolean {
  return n < 3000;
}

export const voucherRowSchema = z.object({
  id: z.string(),
  account: z.number().int(),
  /** Debit amount in öre, always >= 0. */
  debit: z.number().int().min(0),
  /** Credit amount in öre, always >= 0. */
  credit: z.number().int().min(0),
  description: z.string().default(''),
  costCenter: z.string().nullable().default(null),
  project: z.string().nullable().default(null),
  /** VAT code as recorded on the row, when the upstream provides one. */
  vatCode: z.string().nullable().default(null),
});
export type VoucherRow = z.infer<typeof voucherRowSchema>;

export const voucherSchema = z.object({
  id: z.string(),
  /** Fortnox voucher series code, e.g. 'A', 'B', 'LF'. */
  series: z.string(),
  number: z.number().int(),
  transactionDate: isoDateSchema,
  description: z.string(),
  /** True when the voucher was entered by hand rather than by a Fortnox module. */
  manual: z.boolean().default(false),
  /** Whether an attachment/receipt is connected to the voucher in Fortnox. */
  hasFileConnection: z.boolean().default(false),
  /** Origin sub-ledger reference, when the voucher came from an invoice. */
  supplierInvoiceNumber: z.string().nullable().default(null),
  customerInvoiceNumber: z.string().nullable().default(null),
  supplierNumber: z.string().nullable().default(null),
  customerNumber: z.string().nullable().default(null),
  rows: z.array(voucherRowSchema).min(1),
});
export type Voucher = z.infer<typeof voucherSchema>;

export function voucherReference(v: Pick<Voucher, 'series' | 'number'>): string {
  return `${v.series}${v.number}`;
}

export function voucherTotalDebit(v: Pick<Voucher, 'rows'>): number {
  return v.rows.reduce((a, r) => a + r.debit, 0);
}

export function voucherTotalCredit(v: Pick<Voucher, 'rows'>): number {
  return v.rows.reduce((a, r) => a + r.credit, 0);
}

/** Net movement on an account within a voucher (debit positive). */
export function voucherNetOnAccount(v: Pick<Voucher, 'rows'>, account: number): number {
  return v.rows.filter((r) => r.account === account).reduce((a, r) => a + r.debit - r.credit, 0);
}

export const supplierSchema = z.object({
  supplierNumber: z.string(),
  name: z.string(),
  organisationNumber: z.string().nullable().default(null),
  active: z.boolean().default(true),
});
export type Supplier = z.infer<typeof supplierSchema>;

export const customerSchema = z.object({
  customerNumber: z.string(),
  name: z.string(),
  organisationNumber: z.string().nullable().default(null),
  active: z.boolean().default(true),
});
export type Customer = z.infer<typeof customerSchema>;

export const supplierInvoiceSchema = z.object({
  id: z.string(),
  givenNumber: z.string(),
  supplierNumber: z.string(),
  supplierName: z.string(),
  invoiceDate: isoDateSchema,
  dueDate: isoDateSchema,
  /** Total including VAT, in öre. */
  total: z.number().int(),
  vatAmount: z.number().int(),
  currency: z.string().default('SEK'),
  booked: z.boolean().default(false),
  /** Whether a document is attached in Fortnox (file connection). */
  hasFileConnection: z.boolean().default(false),
  voucherId: z.string().nullable().default(null),
});
export type SupplierInvoice = z.infer<typeof supplierInvoiceSchema>;

export const customerInvoiceSchema = z.object({
  id: z.string(),
  documentNumber: z.string(),
  customerNumber: z.string(),
  customerName: z.string(),
  invoiceDate: isoDateSchema,
  dueDate: isoDateSchema,
  total: z.number().int(),
  vatAmount: z.number().int(),
  currency: z.string().default('SEK'),
  booked: z.boolean().default(false),
  fullyPaid: z.boolean().default(false),
  voucherId: z.string().nullable().default(null),
});
export type CustomerInvoice = z.infer<typeof customerInvoiceSchema>;

export const paymentSchema = z.object({
  id: z.string(),
  kind: z.enum(['customer_invoice_payment', 'supplier_invoice_payment']),
  invoiceId: z.string(),
  paymentDate: isoDateSchema,
  amount: z.number().int(),
  booked: z.boolean().default(false),
});
export type Payment = z.infer<typeof paymentSchema>;

export const bankTransactionSchema = z.object({
  id: z.string(),
  bookingDate: isoDateSchema,
  amount: z.number().int(),
  text: z.string(),
  account: z.number().int(),
  matchedVoucherId: z.string().nullable().default(null),
  matchedInvoiceId: z.string().nullable().default(null),
});
export type BankTransaction = z.infer<typeof bankTransactionSchema>;

export const financialYearSchema = z.object({
  id: z.string(),
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  /** Fortnox "AccountChartType", e.g. 'Bas 2025'. */
  accountChartType: z.string().default('Bas'),
});
export type FinancialYear = z.infer<typeof financialYearSchema>;

export const voucherSeriesSchema = z.object({
  code: z.string(),
  description: z.string(),
  manual: z.boolean().default(false),
  year: z.number().int().nullable().default(null),
});
export type VoucherSeries = z.infer<typeof voucherSeriesSchema>;

export const costCenterSchema = z.object({
  code: z.string(),
  description: z.string(),
  active: z.boolean().default(true),
});
export type CostCenter = z.infer<typeof costCenterSchema>;

export const projectSchema = z.object({
  projectNumber: z.string(),
  description: z.string(),
  status: z.enum(['ongoing', 'completed', 'notstarted']).default('ongoing'),
});
export type Project = z.infer<typeof projectSchema>;

/** Everything the rules engine needs for one period, already normalised. */
export interface LedgerSnapshot {
  readonly accounts: readonly Account[];
  readonly vouchers: readonly Voucher[];
  readonly suppliers: readonly Supplier[];
  readonly customers: readonly Customer[];
  readonly supplierInvoices: readonly SupplierInvoice[];
  readonly customerInvoices: readonly CustomerInvoice[];
  readonly payments: readonly Payment[];
  readonly bankTransactions: readonly BankTransaction[];
  readonly costCenters: readonly CostCenter[];
  readonly projects: readonly Project[];
  readonly financialYears: readonly FinancialYear[];
  readonly voucherSeries: readonly VoucherSeries[];
}
