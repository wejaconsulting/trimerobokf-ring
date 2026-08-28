import type {
  Account,
  BankTransaction,
  CostCenter,
  Customer,
  CustomerInvoice,
  FinancialYear,
  IsoDate,
  LedgerSnapshot,
  Payment,
  PeriodKey,
  Project,
  Supplier,
  SupplierInvoice,
  Voucher,
  VoucherSeries,
} from '@trimeros/domain';
import { periodKeyOf } from '@trimeros/domain';
import { UNVERIFIED_CAPABILITIES } from './endpoints.js';
import type { FortnoxCapabilityReport, FortnoxReadPort, FortnoxWritePort, VoucherCreatePayload } from './ports.js';
import { FortnoxWriteBlockedError } from './write-policy.js';

export interface MockFortnoxDataset extends LedgerSnapshot {
  readonly lockedThrough: IsoDate | null;
}

export interface MockAdapterOptions {
  /** Simulated latency in ms, so callers exercise their async paths honestly. */
  readonly latencyMs?: number;
}

/**
 * The only adapter phase 1 runs against.
 *
 * It serves the synthetic dataset and, crucially, mirrors the *shape* of the
 * real adapter's limits: capabilities with no verified public endpoint are
 * reported unavailable here too, so the workflow blocks in exactly the same
 * places it would against a real account.
 */
export class MockFortnoxAdapter implements FortnoxReadPort, FortnoxWritePort {
  readonly adapterName = 'mock';
  readonly #data: MockFortnoxDataset;
  readonly #latencyMs: number;

  constructor(data: MockFortnoxDataset, options: MockAdapterOptions = {}) {
    this.#data = data;
    this.#latencyMs = options.latencyMs ?? 0;
  }

  async capabilities(): Promise<FortnoxCapabilityReport> {
    await this.#tick();
    return {
      adapterName: this.adapterName,
      mode: 'mock',
      writesEnabled: false,
      available: [
        'financial_years',
        'accounts',
        'voucher_series',
        'vouchers',
        'suppliers',
        'customers',
        'supplier_invoices',
        'customer_invoices',
        'payments',
        'cost_centers',
        'projects',
        'locked_period_read',
      ],
      unavailable: Object.entries(UNVERIFIED_CAPABILITIES).map(([capability, reason]) => ({
        capability,
        reason,
      })),
    };
  }

  async listFinancialYears(): Promise<FinancialYear[]> {
    await this.#tick();
    return [...this.#data.financialYears];
  }

  async listAccounts(_financialYearId: string): Promise<Account[]> {
    await this.#tick();
    return [...this.#data.accounts];
  }

  async listVoucherSeries(): Promise<VoucherSeries[]> {
    await this.#tick();
    return [...this.#data.voucherSeries];
  }

  async listVouchers(period: PeriodKey): Promise<Voucher[]> {
    await this.#tick();
    return this.#data.vouchers.filter((v) => periodKeyOf(v.transactionDate) === period);
  }

  async listSuppliers(): Promise<Supplier[]> {
    await this.#tick();
    return [...this.#data.suppliers];
  }

  async listCustomers(): Promise<Customer[]> {
    await this.#tick();
    return [...this.#data.customers];
  }

  async listSupplierInvoices(period: PeriodKey): Promise<SupplierInvoice[]> {
    await this.#tick();
    return this.#data.supplierInvoices.filter((i) => periodKeyOf(i.invoiceDate) === period);
  }

  async listCustomerInvoices(period: PeriodKey): Promise<CustomerInvoice[]> {
    await this.#tick();
    return this.#data.customerInvoices.filter((i) => periodKeyOf(i.invoiceDate) === period);
  }

  async listPayments(period: PeriodKey): Promise<Payment[]> {
    await this.#tick();
    return this.#data.payments.filter((p) => periodKeyOf(p.paymentDate) === period);
  }

  async listBankTransactions(period: PeriodKey): Promise<BankTransaction[]> {
    await this.#tick();
    return this.#data.bankTransactions.filter((t) => periodKeyOf(t.bookingDate) === period);
  }

  async listCostCenters(): Promise<CostCenter[]> {
    await this.#tick();
    return [...this.#data.costCenters];
  }

  async listProjects(): Promise<Project[]> {
    await this.#tick();
    return [...this.#data.projects];
  }

  async getLockedPeriod(): Promise<{ lockedThrough: IsoDate | null }> {
    await this.#tick();
    return { lockedThrough: this.#data.lockedThrough };
  }

  /** Present so the interface is honest; always refuses. */
  async createVoucher(_payload: VoucherCreatePayload): Promise<{ id: string }> {
    throw new FortnoxWriteBlockedError(['mock_adapter_never_writes']);
  }

  async lockPeriod(_through: IsoDate): Promise<void> {
    throw new FortnoxWriteBlockedError(['mock_adapter_never_writes']);
  }

  /** Full snapshot, for the importer. */
  snapshot(): MockFortnoxDataset {
    return this.#data;
  }

  async #tick(): Promise<void> {
    if (this.#latencyMs > 0) await new Promise((r) => setTimeout(r, this.#latencyMs));
  }
}
