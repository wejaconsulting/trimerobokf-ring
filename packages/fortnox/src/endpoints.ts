/**
 * Fortnox endpoints.
 *
 * Only paths corroborated by official Fortnox documentation or by the
 * published Fortnox OpenAPI specification (as shipped in generated client
 * libraries) appear here. A capability with no corroborated endpoint is absent
 * from this map by design: the readiness step then reports it as unavailable
 * rather than the system quietly guessing a URL. See
 * docs/fortnox-capability-matrix.md for the evidence behind every entry.
 */
export const FORTNOX_API_VERSION = '3';

export const FORTNOX_ENDPOINTS = {
  companyInformation: '/3/companyinformation',
  financialYears: '/3/financialyears',
  financialYearByDate: '/3/financialyears?date={date}',
  accounts: '/3/accounts',
  accountByNumber: '/3/accounts/{accountNumber}?financialyear={financialYearId}',
  voucherSeries: '/3/voucherseries',
  vouchers: '/3/vouchers',
  voucherByNumber: '/3/vouchers/{series}/{number}?financialyear={financialYearId}',
  voucherFileConnections: '/3/voucherfileconnections',
  suppliers: '/3/suppliers',
  customers: '/3/customers',
  supplierInvoices: '/3/supplierinvoices',
  supplierInvoiceFileConnections: '/3/supplierinvoicefileconnections',
  supplierInvoicePayments: '/3/supplierinvoicepayments',
  invoices: '/3/invoices',
  invoicePayments: '/3/invoicepayments',
  costCenters: '/3/costcenters',
  projects: '/3/projects',
  lockedPeriod: '/3/settings/lockedperiod',
  sie: '/3/sie/{type}',
} as const;

export type FortnoxEndpointKey = keyof typeof FORTNOX_ENDPOINTS;

/** Wrapper keys Fortnox uses around list responses. */
export const FORTNOX_LIST_KEYS = {
  financialYears: 'FinancialYears',
  accounts: 'Accounts',
  voucherSeries: 'VoucherSeriesCollection',
  vouchers: 'Vouchers',
  voucherFileConnections: 'VoucherFileConnections',
  suppliers: 'Suppliers',
  customers: 'Customers',
  supplierInvoices: 'SupplierInvoices',
  supplierInvoiceFileConnections: 'SupplierInvoiceFileConnections',
  supplierInvoicePayments: 'SupplierInvoicePayments',
  invoices: 'Invoices',
  invoicePayments: 'InvoicePayments',
  costCenters: 'CostCenters',
  projects: 'Projects',
} as const;

/**
 * Capabilities the workflow needs for which no public endpoint has been
 * verified. These map to `requires Fortnox confirmation` rows in the matrix and
 * are what make the corresponding workflow steps report `not_implemented`
 * instead of silently succeeding.
 */
export const UNVERIFIED_CAPABILITIES: Readonly<Record<string, string>> = {
  bank_transactions:
    'Bokföring från kontoutdrag is a Fortnox product feature; no public API resource for reading bank transactions was verified.',
  bank_transaction_matching:
    'Matching a bank transaction to an invoice or voucher is documented as an in-product feature only.',
  fortnox_regelverk:
    'The rules engine behind Bokföring från kontoutdrag is documented as a product feature, not a public API resource.',
  begar_underlag:
    'Requesting documentation from a client is documented as an in-product feature only.',
  skattekonto:
    'The Skatteverket tax-account connection is documented as a product integration, not a public API resource.',
  balance_and_income_reports:
    'No public report endpoint verified; SIE export is the documented route to ledger data.',
  locked_period_write:
    'Reading a locked period is documented; setting one via the API was not verified, and is out of scope for shadow mode regardless.',
} as const;
