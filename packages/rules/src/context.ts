import type {
  FinancialYear,
  IsoDate,
  LedgerSnapshot,
  Ore,
  PeriodKey,
  SupplierInvoice,
  Voucher,
} from '@trimeros/domain';

/** The client policy inputs the rules engine needs. */
export interface RulePolicy {
  readonly materialityThreshold: Ore;
  readonly automationAmountLimit: Ore;
  readonly costCenterRequiredAccounts: readonly number[];
  readonly projectRequiredAccounts: readonly number[];
  readonly requireDocumentationForInputVat: boolean;
  readonly historyWindowMonths: number;
  readonly amountDeviationThreshold: number;
  readonly vatRates: readonly number[];
}

export interface RuleContext {
  readonly clientId: string;
  readonly period: PeriodKey;
  readonly policy: RulePolicy;
  /** Vouchers and sub-ledger records dated inside `period`. */
  readonly current: LedgerSnapshot;
  /** Everything the history window covers, excluding `period`. */
  readonly historyVouchers: readonly Voucher[];
  /**
   * Supplier invoices across every period, not just `period`.
   *
   * Needed because the interesting cases are precisely the ones where the
   * invoice date and the booking date fall in different months - filtering
   * these by period would hide the anomaly the rule exists to find.
   */
  readonly allSupplierInvoices: readonly SupplierInvoice[];
  readonly financialYears: readonly FinancialYear[];
  /** Date through which Fortnox reports the books locked. */
  readonly lockedThrough: IsoDate | null;
  /**
   * Capabilities the configured Fortnox adapter cannot serve. A rule that needs
   * one of these must not guess - it produces a manual-assessment finding.
   */
  readonly unavailableCapabilities: readonly { readonly capability: string; readonly reason: string }[];
  /**
   * Source record keys already booked by a previous run. Used by the
   * "same source record cannot be booked twice" validation, which is what makes
   * re-running a close run safe.
   */
  readonly alreadyProcessedSourceKeys: ReadonlySet<string>;
}
