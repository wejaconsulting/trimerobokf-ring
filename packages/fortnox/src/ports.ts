import type {
  Account,
  BankTransaction,
  CostCenter,
  Customer,
  CustomerInvoice,
  FinancialYear,
  IsoDate,
  Payment,
  PeriodKey,
  Project,
  Supplier,
  SupplierInvoice,
  Voucher,
  VoucherSeries,
} from '@trimeros/domain';

/**
 * The Fortnox boundary.
 *
 * Read and write are separate ports on purpose. Everything in phase 1 depends
 * only on `FortnoxReadPort`; `FortnoxWritePort` exists so the shape of a future
 * write is explicit and reviewable, but no code path in this phase calls it
 * against a real account.
 */

export interface FortnoxReadPort {
  readonly adapterName: string;
  /** Endpoints this adapter can actually serve, for the readiness step. */
  capabilities(): Promise<FortnoxCapabilityReport>;

  listFinancialYears(): Promise<FinancialYear[]>;
  listAccounts(financialYearId: string): Promise<Account[]>;
  listVoucherSeries(): Promise<VoucherSeries[]>;
  listVouchers(period: PeriodKey): Promise<Voucher[]>;
  listSuppliers(): Promise<Supplier[]>;
  listCustomers(): Promise<Customer[]>;
  listSupplierInvoices(period: PeriodKey): Promise<SupplierInvoice[]>;
  listCustomerInvoices(period: PeriodKey): Promise<CustomerInvoice[]>;
  listPayments(period: PeriodKey): Promise<Payment[]>;
  listBankTransactions(period: PeriodKey): Promise<BankTransaction[]>;
  listCostCenters(): Promise<CostCenter[]>;
  listProjects(): Promise<Project[]>;
  /** The date through which Fortnox reports the books as locked, if any. */
  getLockedPeriod(): Promise<{ lockedThrough: IsoDate | null }>;
}

export interface FortnoxWritePort {
  createVoucher(payload: VoucherCreatePayload): Promise<{ id: string }>;
  lockPeriod(through: IsoDate): Promise<void>;
}

export interface FortnoxCapabilityReport {
  readonly adapterName: string;
  readonly mode: 'mock' | 'real_read_only' | 'real_read_write';
  readonly writesEnabled: boolean;
  readonly available: readonly string[];
  /** Capabilities the system needs but cannot serve, with the reason. */
  readonly unavailable: readonly { readonly capability: string; readonly reason: string }[];
}

/**
 * The exact JSON body that would be POSTed to Fortnox.
 *
 * Field names follow Fortnox's documented Voucher resource conventions
 * (PascalCase, amounts in kronor as decimal numbers, `TransactionDate` as
 * YYYY-MM-DD). They are NOT byte-for-byte verified against the live
 * documentation - see docs/fortnox-capability-matrix.md - which is one of the
 * reasons writes stay disabled until a human verifies the contract.
 */
export interface VoucherCreatePayload {
  readonly Voucher: {
    readonly Description: string;
    readonly TransactionDate: IsoDate;
    readonly VoucherSeries: string;
    readonly VoucherRows: readonly {
      readonly Account: number;
      readonly Debit: number;
      readonly Credit: number;
      readonly Description?: string;
      readonly CostCenter?: string;
      readonly Project?: string;
      readonly TransactionInformation?: string;
    }[];
  };
}
