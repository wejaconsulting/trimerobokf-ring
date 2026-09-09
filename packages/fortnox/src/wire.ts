import { z } from 'zod';
import type {
  Account,
  CostCenter,
  Customer,
  CustomerInvoice,
  FinancialYear,
  Payment,
  Project,
  Supplier,
  SupplierInvoice,
  Voucher,
  VoucherRow,
  VoucherSeries,
} from '@trimeros/domain';
import { accountTypeFromNumber } from '@trimeros/domain';

/**
 * Wire shapes of the Fortnox resources this system reads, and the mapping to
 * the domain's normalised, öre-denominated types.
 *
 * Field names come from the Fortnox OpenAPI specification as published in
 * generated client libraries (see docs/fortnox-capability-matrix.md,
 * "Response shapes"). Every schema is deliberately permissive about fields it
 * does not need - Fortnox adds fields over time and that must not break an
 * import - and strict about the few it does.
 *
 * Money: Fortnox sends decimal kronor, as JSON numbers on most resources and
 * as strings on supplier invoices. Both are converted to integer öre here, and
 * only here, on the way in.
 */

const money = z.union([z.number(), z.string()]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Decimal kronor (number or string) to integer öre without float drift. */
export function kronorToOre(value: number | string): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim().replace(',', '.');
  const match = /^(-?)(\d+)(?:\.(\d{0,2})\d*)?$/.exec(text);
  if (!match) return Math.round(Number(text) * 100) || 0;
  const [, sign, whole, frac = ''] = match;
  const ore = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return sign === '-' ? -ore : ore;
}

// --- financial years ------------------------------------------------------

export const wireFinancialYear = z.object({
  Id: z.number().int(),
  FromDate: isoDate,
  ToDate: isoDate,
  AccountingMethod: z.string().optional(),
  accountCharts: z.string().optional(),
  AccountChartType: z.string().optional(),
});
export type WireFinancialYear = z.infer<typeof wireFinancialYear>;

export function mapFinancialYear(w: WireFinancialYear): FinancialYear {
  return {
    id: String(w.Id),
    fromDate: w.FromDate,
    toDate: w.ToDate,
    accountChartType: w.AccountChartType ?? w.accountCharts ?? 'Bas',
  };
}

// --- accounts ---------------------------------------------------------------

export const wireAccount = z.object({
  Number: z.number().int(),
  Description: z.string().default(''),
  Active: z.boolean().optional(),
  VATCode: z.string().nullable().optional(),
  CostCenterSettings: z.string().optional(),
  ProjectSettings: z.string().optional(),
});
export type WireAccount = z.infer<typeof wireAccount>;

export function mapAccount(w: WireAccount): Account {
  return {
    number: w.Number,
    description: w.Description,
    type: accountTypeFromNumber(w.Number),
    active: w.Active ?? true,
    vatCode: w.VATCode ? w.VATCode : null,
    costCenterRequired: w.CostCenterSettings === 'MANDATORY',
    projectRequired: w.ProjectSettings === 'MANDATORY',
  };
}

// --- voucher series ---------------------------------------------------------

export const wireVoucherSeries = z.object({
  Code: z.string(),
  Description: z.string().optional(),
  Manual: z.boolean().optional(),
  Year: z.number().int().optional(),
});
export type WireVoucherSeries = z.infer<typeof wireVoucherSeries>;

export function mapVoucherSeries(w: WireVoucherSeries): VoucherSeries {
  return {
    code: w.Code,
    description: w.Description ?? '',
    manual: w.Manual ?? false,
    year: w.Year ?? null,
  };
}

// --- vouchers ---------------------------------------------------------------

/** The list view: no rows. */
export const wireVoucherListItem = z.object({
  VoucherSeries: z.string(),
  VoucherNumber: z.number().int(),
  Year: z.number().int(),
  TransactionDate: isoDate,
  Description: z.string().nullable().optional(),
  ReferenceNumber: z.string().nullable().optional(),
  ReferenceType: z.string().nullable().optional(),
});
export type WireVoucherListItem = z.infer<typeof wireVoucherListItem>;

export const wireVoucherRow = z.object({
  Account: z.number().int(),
  Debit: money.optional(),
  Credit: money.optional(),
  Description: z.string().nullable().optional(),
  TransactionInformation: z.string().nullable().optional(),
  CostCenter: z.string().nullable().optional(),
  Project: z.string().nullable().optional(),
  Removed: z.boolean().optional(),
});

export const wireVoucher = wireVoucherListItem.extend({
  VoucherRows: z.array(wireVoucherRow).default([]),
});
export type WireVoucher = z.infer<typeof wireVoucher>;

/** A single voucher as Fortnox returns it: wrapped in its resource name. */
export const wireVoucherEnvelope = z.object({ Voucher: wireVoucher });

/**
 * A voucher's identity in this system: financial-year id, series and number.
 * Fortnox numbers restart every financial year, so all three are needed.
 */
export function voucherIdOf(year: number, series: string, number: number): string {
  return `${year}-${series}-${number}`;
}

export interface VoucherMapContext {
  readonly hasFileConnection: (voucherId: string) => boolean;
  readonly supplierNumberForInvoice: (givenNumber: string) => string | null;
  readonly customerNumberForInvoice: (documentNumber: string) => string | null;
  /**
   * Fallback for vouchers with no sub-ledger link (a manually booked purchase,
   * a voucher whose invoice was removed): the supplier whose registered name
   * appears verbatim in the voucher text, if exactly one does. Deterministic
   * and explainable; never a guess between candidates.
   */
  readonly supplierNumberForText?: (text: string) => string | null;
}

export function mapVoucher(w: WireVoucher, ctx: VoucherMapContext): Voucher {
  const id = voucherIdOf(w.Year, w.VoucherSeries, w.VoucherNumber);
  const reference = w.ReferenceNumber ?? null;
  const type = w.ReferenceType ?? null;
  const supplierInvoiceNumber = type === 'SUPPLIERINVOICE' ? reference : null;
  const customerInvoiceNumber = type === 'INVOICE' ? reference : null;
  const linkedSupplier = supplierInvoiceNumber ? ctx.supplierNumberForInvoice(supplierInvoiceNumber) : null;
  const supplierNumber =
    linkedSupplier ?? (ctx.supplierNumberForText ? ctx.supplierNumberForText(w.Description ?? '') : null);

  const rows: VoucherRow[] = w.VoucherRows.filter((r) => !r.Removed).map((r, index) => ({
    id: `${id}-${index + 1}`,
    account: r.Account,
    debit: kronorToOre(r.Debit ?? 0),
    credit: kronorToOre(r.Credit ?? 0),
    description: r.TransactionInformation ?? r.Description ?? '',
    costCenter: r.CostCenter ? r.CostCenter : null,
    project: r.Project ? r.Project : null,
    // Fortnox voucher rows carry no VAT code; the account's code is the signal.
    vatCode: null,
  }));

  return {
    id,
    series: w.VoucherSeries,
    number: w.VoucherNumber,
    transactionDate: w.TransactionDate,
    description: w.Description ?? '',
    manual: type === 'MANUAL' || type === null,
    hasFileConnection: ctx.hasFileConnection(id),
    supplierInvoiceNumber,
    customerInvoiceNumber,
    supplierNumber,
    customerNumber: customerInvoiceNumber ? ctx.customerNumberForInvoice(customerInvoiceNumber) : null,
    rows,
  };
}

export const wireVoucherFileConnection = z.object({
  FileId: z.string(),
  VoucherSeries: z.string(),
  VoucherNumber: z.union([z.string(), z.number()]),
  VoucherYear: z.number().int().optional(),
});
export type WireVoucherFileConnection = z.infer<typeof wireVoucherFileConnection>;

/**
 * Builds the name matcher behind `supplierNumberForText`. Names shorter than
 * four characters are ignored: "AB" would match everything.
 */
export function supplierNameMatcher(suppliers: readonly Supplier[]): (text: string) => string | null {
  const candidates = suppliers
    .filter((s) => s.name.trim().length >= 4)
    .map((s) => ({ number: s.supplierNumber, name: s.name.trim().toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  return (text) => {
    const haystack = text.toLowerCase();
    const matches = candidates.filter((c) => haystack.includes(c.name));
    if (matches.length === 0) return null;
    // Distinct supplier numbers among the matches; only a unique hit counts.
    const numbers = new Set(matches.map((m) => m.number));
    if (numbers.size === 1) return matches[0]?.number ?? null;
    // Several suppliers matched: accept only if one name contains all others
    // (e.g. "Ren & Fin AB" inside "Städbolaget Ren & Fin AB").
    const longest = matches[0];
    if (longest && matches.every((m) => longest.name.includes(m.name))) return longest.number;
    return null;
  };
}

// --- counterparties ---------------------------------------------------------

export const wireSupplier = z.object({
  SupplierNumber: z.string(),
  Name: z.string().default(''),
  OrganisationNumber: z.string().nullable().optional(),
  Active: z.boolean().optional(),
});
export function mapSupplier(w: z.infer<typeof wireSupplier>): Supplier {
  return {
    supplierNumber: w.SupplierNumber,
    name: w.Name,
    organisationNumber: w.OrganisationNumber ? w.OrganisationNumber : null,
    active: w.Active ?? true,
  };
}

export const wireCustomer = z.object({
  CustomerNumber: z.string(),
  Name: z.string().default(''),
  OrganisationNumber: z.string().nullable().optional(),
  Active: z.boolean().optional(),
});
export function mapCustomer(w: z.infer<typeof wireCustomer>): Customer {
  return {
    customerNumber: w.CustomerNumber,
    name: w.Name,
    organisationNumber: w.OrganisationNumber ? w.OrganisationNumber : null,
    active: w.Active ?? true,
  };
}

// --- invoices ---------------------------------------------------------------

const wireVoucherRef = z.object({
  Number: z.number().int().optional(),
  Year: z.number().int().optional(),
  Series: z.string().optional(),
});

export const wireSupplierInvoice = z.object({
  GivenNumber: z.union([z.string(), z.number()]),
  SupplierNumber: z.string(),
  SupplierName: z.string().nullable().optional(),
  InvoiceDate: isoDate,
  DueDate: isoDate.nullable().optional(),
  Total: money.optional(),
  VAT: money.optional(),
  Currency: z.string().nullable().optional(),
  Booked: z.boolean().optional(),
  Cancelled: z.boolean().optional(),
  Cancel: z.boolean().optional(),
  Vouchers: z.array(wireVoucherRef).optional(),
  VoucherNumber: z.number().int().optional(),
  VoucherSeries: z.string().optional(),
  VoucherYear: z.number().int().optional(),
});
export type WireSupplierInvoice = z.infer<typeof wireSupplierInvoice>;

export function mapSupplierInvoice(
  w: WireSupplierInvoice,
  hasFileConnection: (givenNumber: string) => boolean,
): SupplierInvoice {
  const givenNumber = String(w.GivenNumber);
  const ref = w.Vouchers?.[0];
  const voucherId =
    ref?.Year !== undefined && ref.Series && ref.Number !== undefined
      ? voucherIdOf(ref.Year, ref.Series, ref.Number)
      : w.VoucherYear !== undefined && w.VoucherSeries && w.VoucherNumber !== undefined
        ? voucherIdOf(w.VoucherYear, w.VoucherSeries, w.VoucherNumber)
        : null;
  return {
    id: givenNumber,
    givenNumber,
    supplierNumber: w.SupplierNumber,
    supplierName: w.SupplierName ?? '',
    invoiceDate: w.InvoiceDate,
    dueDate: w.DueDate ?? w.InvoiceDate,
    total: kronorToOre(w.Total ?? 0),
    // The list view carries no VAT amount; the detail view does. Rules do not
    // depend on it, so the list value is used and VAT is reported as unknown (0).
    vatAmount: w.VAT !== undefined ? kronorToOre(w.VAT) : 0,
    currency: w.Currency ?? 'SEK',
    booked: w.Booked ?? false,
    hasFileConnection: hasFileConnection(givenNumber),
    voucherId,
  };
}

export const wireSupplierInvoiceFileConnection = z.object({
  FileId: z.string().optional(),
  SupplierInvoiceNumber: z.union([z.string(), z.number()]).optional(),
});

export const wireCustomerInvoice = z.object({
  DocumentNumber: z.union([z.string(), z.number()]),
  CustomerNumber: z.string().default(''),
  CustomerName: z.string().nullable().optional(),
  InvoiceDate: isoDate,
  DueDate: isoDate.nullable().optional(),
  Total: money.optional(),
  Balance: money.optional(),
  Currency: z.string().nullable().optional(),
  Booked: z.boolean().optional(),
  Cancelled: z.boolean().optional(),
  VoucherNumber: z.number().int().nullable().optional(),
  VoucherSeries: z.string().nullable().optional(),
  VoucherYear: z.number().int().nullable().optional(),
});
export type WireCustomerInvoice = z.infer<typeof wireCustomerInvoice>;

export function mapCustomerInvoice(w: WireCustomerInvoice): CustomerInvoice {
  const documentNumber = String(w.DocumentNumber);
  const voucherId =
    w.VoucherYear != null && w.VoucherSeries && w.VoucherNumber != null
      ? voucherIdOf(w.VoucherYear, w.VoucherSeries, w.VoucherNumber)
      : null;
  return {
    id: documentNumber,
    documentNumber,
    customerNumber: w.CustomerNumber,
    customerName: w.CustomerName ?? '',
    invoiceDate: w.InvoiceDate,
    dueDate: w.DueDate ?? w.InvoiceDate,
    total: kronorToOre(w.Total ?? 0),
    vatAmount: 0,
    currency: w.Currency ?? 'SEK',
    booked: w.Booked ?? false,
    fullyPaid: w.Balance !== undefined ? kronorToOre(w.Balance) === 0 : false,
    voucherId,
  };
}

// --- payments ---------------------------------------------------------------

export const wirePayment = z.object({
  Number: z.union([z.string(), z.number()]).optional(),
  InvoiceNumber: z.union([z.string(), z.number()]),
  PaymentDate: isoDate.nullable().optional(),
  Amount: money.optional(),
  Booked: z.boolean().optional(),
});
export type WirePayment = z.infer<typeof wirePayment>;

export function mapPayment(w: WirePayment, kind: Payment['kind']): Payment | null {
  if (!w.PaymentDate) return null;
  const invoiceId = String(w.InvoiceNumber);
  return {
    id: `${kind}-${w.Number ?? invoiceId}-${w.PaymentDate}`,
    kind,
    invoiceId,
    paymentDate: w.PaymentDate,
    amount: kronorToOre(w.Amount ?? 0),
    booked: w.Booked ?? false,
  };
}

// --- dimensions -------------------------------------------------------------

export const wireCostCenter = z.object({
  Code: z.string(),
  Description: z.string().default(''),
  Active: z.boolean().optional(),
});
export function mapCostCenter(w: z.infer<typeof wireCostCenter>): CostCenter {
  return { code: w.Code, description: w.Description, active: w.Active ?? true };
}

export const wireProject = z.object({
  ProjectNumber: z.union([z.string(), z.number()]),
  Description: z.string().default(''),
  Status: z.string().optional(),
});
export function mapProject(w: z.infer<typeof wireProject>): Project {
  const status = (w.Status ?? 'ONGOING').toLowerCase();
  return {
    projectNumber: String(w.ProjectNumber),
    description: w.Description,
    status: status === 'completed' || status === 'notstarted' ? status : 'ongoing',
  };
}

// --- settings ---------------------------------------------------------------

export const wireLockedPeriod = z.object({
  LockedPeriod: z.object({ EndDate: z.string().nullable().optional() }).optional(),
});

/** Response of a voucher create: the voucher as stored, with its number. */
export const wireVoucherCreated = z.object({
  Voucher: z.object({
    VoucherSeries: z.string(),
    VoucherNumber: z.number().int(),
    Year: z.number().int(),
  }),
});
