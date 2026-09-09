import type {
  Account,
  BankTransaction,
  CostCenter,
  Customer,
  CustomerInvoice,
  FinancialYear,
  HttpFetch,
  IsoDate,
  Payment,
  PeriodKey,
  Project,
  Supplier,
  SupplierInvoice,
  Voucher,
  VoucherSeries,
} from '@trimeros/domain';
import { periodEnd, periodKeyOf, periodStart } from '@trimeros/domain';
import { FORTNOX_ENDPOINTS, FORTNOX_LIST_KEYS, UNVERIFIED_CAPABILITIES } from './endpoints.js';
import {
  FortnoxApiError,
  FortnoxHttpClient,
  type AccessTokenProvider,
} from './http/client.js';
import type { FortnoxCapabilityReport, FortnoxReadPort, FortnoxWritePort, VoucherCreatePayload } from './ports.js';
import {
  mapAccount,
  mapCostCenter,
  mapCustomer,
  mapCustomerInvoice,
  mapFinancialYear,
  mapPayment,
  mapProject,
  mapSupplier,
  mapSupplierInvoice,
  mapVoucher,
  mapVoucherSeries,
  supplierNameMatcher,
  voucherIdOf,
  wireAccount,
  wireCostCenter,
  wireCustomer,
  wireCustomerInvoice,
  wireFinancialYear,
  wireLockedPeriod,
  wirePayment,
  wireProject,
  wireSupplier,
  wireSupplierInvoice,
  wireSupplierInvoiceFileConnection,
  wireVoucherCreated,
  wireVoucherEnvelope,
  wireVoucherFileConnection,
  wireVoucherListItem,
  wireVoucherSeries,
} from './wire.js';
import { FortnoxWriteBlockedError, type WriteContext, assertWriteAllowed } from './write-policy.js';

export type { AccessTokenProvider } from './http/client.js';

/**
 * The real Fortnox adapter.
 *
 * Reads go over HTTPS to `api.fortnox.se` with a bearer token from the
 * injected provider (in production: `FortnoxConnectionService`, which refreshes
 * and re-seals tokens itself). Everything is normalised to the domain types on
 * the way in, so the rules engine never sees a Fortnox field name.
 *
 * Security properties this class is responsible for:
 *  - The access token is obtained per request from the provider and lives only
 *    inside the HTTP client. It is never logged, never returned, and never
 *    placed in an object that reaches a model.
 *  - Every write method calls `assertWriteAllowed` first. Under shadow mode
 *    that call always throws, and the constructor refuses a write-enabled
 *    configuration while shadow mode is on.
 *
 * Instances are meant to live for one close run: the caches below hold
 * reference data (financial years, file connections, sub-ledgers) so the
 * voucher import does not re-fetch them for every period in the history
 * window. They are never shared between clients.
 */

export interface RealFortnoxAdapterOptions {
  readonly baseUrl: string;
  readonly tokenProvider: AccessTokenProvider;
  /** Must stay false while `shadowMode` is true. */
  readonly writesEnabled: boolean;
  readonly shadowMode: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: HttpFetch;
  /** Injected in tests; built from the options otherwise. */
  readonly client?: FortnoxHttpClient;
}

const E = FORTNOX_ENDPOINTS;
const K = FORTNOX_LIST_KEYS;

/** Voucher detail calls in flight at once. The rate limiter paces them anyway. */
const VOUCHER_DETAIL_CONCURRENCY = 4;

export class RealFortnoxAdapter implements FortnoxReadPort, FortnoxWritePort {
  readonly adapterName = 'fortnox-real';
  readonly #options: RealFortnoxAdapterOptions;
  readonly #client: FortnoxHttpClient;
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(options: RealFortnoxAdapterOptions) {
    if (options.writesEnabled && options.shadowMode) {
      // Defence in depth: refuse to even construct a write-enabled adapter
      // while the global shadow-mode switch is on.
      throw new FortnoxWriteBlockedError(['writes_enabled_while_shadow_mode_active']);
    }
    this.#options = options;
    this.#client =
      options.client ??
      new FortnoxHttpClient({
        baseUrl: options.baseUrl,
        tokenProvider: options.tokenProvider,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
  }

  async capabilities(): Promise<FortnoxCapabilityReport> {
    return {
      adapterName: this.adapterName,
      mode: this.#options.writesEnabled ? 'real_read_write' : 'real_read_only',
      writesEnabled: this.#options.writesEnabled,
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
        ...(this.#options.writesEnabled ? ['voucher_create'] : []),
      ],
      unavailable: Object.entries(UNVERIFIED_CAPABILITIES).map(([capability, reason]) => ({
        capability,
        reason,
      })),
    };
  }

  // --- reads --------------------------------------------------------------

  listFinancialYears(): Promise<FinancialYear[]> {
    return this.#cached('financialYears', async () => {
      const rows = await this.#client.list(E.financialYears, {}, K.financialYears, wireFinancialYear);
      return rows.map(mapFinancialYear).sort((a, b) => a.fromDate.localeCompare(b.fromDate));
    });
  }

  async listAccounts(financialYearId: string): Promise<Account[]> {
    const rows = await this.#client.list(
      E.accounts,
      { financialyear: financialYearId },
      K.accounts,
      wireAccount,
    );
    return rows.map(mapAccount);
  }

  listVoucherSeries(): Promise<VoucherSeries[]> {
    return this.#cached('voucherSeries', async () => {
      const rows = await this.#client.list(E.voucherSeries, {}, K.voucherSeries, wireVoucherSeries);
      return rows.map(mapVoucherSeries);
    });
  }

  /**
   * Vouchers dated inside the period, with their rows.
   *
   * Fortnox's list view has no rows, so each voucher is fetched individually.
   * That is the expensive call of the whole import, which is why the readiness
   * step caches locked history periods in the database rather than asking for
   * them again on every run.
   */
  async listVouchers(period: PeriodKey): Promise<Voucher[]> {
    const year = await this.#financialYearFor(periodStart(period));
    if (!year) return [];

    const heads = await this.#client.list(
      E.vouchers,
      { financialyear: year.id, fromdate: periodStart(period), todate: periodEnd(period) },
      K.vouchers,
      wireVoucherListItem,
    );

    const [fileConnections, supplierByInvoice, customerByInvoice, suppliers] = await Promise.all([
      this.#voucherFileConnections(),
      this.#supplierNumberByInvoice(),
      this.#customerNumberByInvoice(),
      this.listSuppliers(),
    ]);
    const mapContext = {
      hasFileConnection: (id: string) => fileConnections.has(id),
      supplierNumberForInvoice: (n: string) => supplierByInvoice.get(n) ?? null,
      customerNumberForInvoice: (n: string) => customerByInvoice.get(n) ?? null,
      supplierNumberForText: supplierNameMatcher(suppliers),
    };

    const vouchers: Voucher[] = [];
    // The date filter is applied again here: Fortnox's `fromdate`/`todate`
    // are trusted, but a voucher outside the period must never reach a rule.
    const inPeriod = heads.filter((h) => periodKeyOf(h.TransactionDate) === period);
    await mapWithConcurrency(inPeriod, VOUCHER_DETAIL_CONCURRENCY, async (head) => {
      const detail = await this.#client.get(
        `${E.vouchers}/${encodeURIComponent(head.VoucherSeries)}/${head.VoucherNumber}`,
        { financialyear: head.Year },
        wireVoucherEnvelope,
      );
      const voucher = mapVoucher(detail.Voucher, mapContext);
      if (voucher.rows.length > 0) vouchers.push(voucher);
    });

    return vouchers.sort((a, b) =>
      a.transactionDate === b.transactionDate
        ? a.series === b.series
          ? a.number - b.number
          : a.series.localeCompare(b.series)
        : a.transactionDate.localeCompare(b.transactionDate),
    );
  }

  listSuppliers(): Promise<Supplier[]> {
    return this.#cached('suppliers', async () => {
      const rows = await this.#client.list(E.suppliers, {}, K.suppliers, wireSupplier);
      return rows.map(mapSupplier);
    });
  }

  listCustomers(): Promise<Customer[]> {
    return this.#cached('customers', async () => {
      const rows = await this.#client.list(E.customers, {}, K.customers, wireCustomer);
      return rows.map(mapCustomer);
    });
  }

  async listSupplierInvoices(period: PeriodKey): Promise<SupplierInvoice[]> {
    const all = await this.#allSupplierInvoices();
    return all.filter((i) => periodKeyOf(i.invoiceDate) === period);
  }

  async listCustomerInvoices(period: PeriodKey): Promise<CustomerInvoice[]> {
    const rows = await this.#client.list(
      E.invoices,
      { fromdate: periodStart(period), todate: periodEnd(period) },
      K.invoices,
      wireCustomerInvoice,
    );
    return rows
      .filter((r) => !r.Cancelled)
      .map(mapCustomerInvoice)
      .filter((i) => periodKeyOf(i.invoiceDate) === period);
  }

  async listPayments(period: PeriodKey): Promise<Payment[]> {
    const all = await this.#cached('payments', async () => {
      const [supplier, customer] = await Promise.all([
        this.#client.list(E.supplierInvoicePayments, {}, K.supplierInvoicePayments, wirePayment),
        this.#client.list(E.invoicePayments, {}, K.invoicePayments, wirePayment),
      ]);
      return [
        ...supplier.map((p) => mapPayment(p, 'supplier_invoice_payment')),
        ...customer.map((p) => mapPayment(p, 'customer_invoice_payment')),
      ].filter((p): p is Payment => p !== null);
    });
    return all.filter((p) => periodKeyOf(p.paymentDate) === period);
  }

  listBankTransactions(_period: PeriodKey): Promise<BankTransaction[]> {
    return Promise.reject(
      new Error(`Unavailable: ${UNVERIFIED_CAPABILITIES.bank_transactions ?? 'unverified'}`),
    );
  }

  listCostCenters(): Promise<CostCenter[]> {
    return this.#cached('costCenters', async () => {
      const rows = await this.#client.list(E.costCenters, {}, K.costCenters, wireCostCenter);
      return rows.map(mapCostCenter);
    });
  }

  listProjects(): Promise<Project[]> {
    return this.#cached('projects', async () => {
      const rows = await this.#client.list(E.projects, {}, K.projects, wireProject);
      return rows.map(mapProject);
    });
  }

  /**
   * The locked period.
   *
   * A 404 here means the account exposes no lock (or the resource is not
   * licensed), which is reported as "not locked" - the rules then treat every
   * period as open, which is the conservative reading for proposals.
   */
  async getLockedPeriod(): Promise<{ lockedThrough: IsoDate | null }> {
    try {
      const body = await this.#client.get(E.lockedPeriod, {}, wireLockedPeriod);
      const end = body.LockedPeriod?.EndDate;
      return { lockedThrough: end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null };
    } catch (error) {
      if (error instanceof FortnoxApiError && error.status === 404) return { lockedThrough: null };
      throw error;
    }
  }

  // --- writes -------------------------------------------------------------

  /**
   * Creates a voucher. Reachable only when the seven-condition write gate
   * passes for this exact payload; see write-policy.ts and docs/shadow-mode.md.
   */
  async createVoucher(
    payload: VoucherCreatePayload,
    context?: WriteContext,
  ): Promise<{ id: string; reference: string }> {
    this.#guardWrite(context);
    const year = await this.#financialYearFor(payload.Voucher.TransactionDate);
    if (!year) {
      throw new FortnoxWriteBlockedError(['no_financial_year_for_transaction_date']);
    }
    const created = await this.#client.post(
      E.vouchers,
      { financialyear: year.id },
      payload,
      wireVoucherCreated,
    );
    const v = created.Voucher;
    return {
      id: voucherIdOf(v.Year, v.VoucherSeries, v.VoucherNumber),
      reference: `${v.VoucherSeries}${v.VoucherNumber}`,
    };
  }

  async lockPeriod(_through: IsoDate, context?: WriteContext): Promise<void> {
    this.#guardWrite(context);
    // Even a fully approved context cannot lock: the write was never verified
    // against Fortnox's contract and is out of scope for this system.
    throw new FortnoxWriteBlockedError(['locked_period_write_unverified']);
  }

  #guardWrite(context: WriteContext | undefined): void {
    if (!this.#options.writesEnabled) {
      throw new FortnoxWriteBlockedError(['adapter_writes_disabled']);
    }
    if (!context) {
      throw new FortnoxWriteBlockedError(['no_write_context_supplied']);
    }
    assertWriteAllowed(context);
  }

  // --- reference data -----------------------------------------------------

  async #financialYearFor(date: IsoDate): Promise<FinancialYear | undefined> {
    const years = await this.listFinancialYears();
    return years.find((y) => y.fromDate <= date && date <= y.toDate);
  }

  #voucherFileConnections(): Promise<Set<string>> {
    return this.#cached('voucherFileConnections', async () => {
      const rows = await this.#client.list(
        E.voucherFileConnections,
        {},
        K.voucherFileConnections,
        wireVoucherFileConnection,
      );
      return new Set(
        rows
          .filter((r) => r.VoucherYear !== undefined)
          .map((r) => voucherIdOf(r.VoucherYear ?? 0, r.VoucherSeries, Number(r.VoucherNumber))),
      );
    });
  }

  #allSupplierInvoices(): Promise<SupplierInvoice[]> {
    return this.#cached('supplierInvoices', async () => {
      const [rows, files] = await Promise.all([
        this.#client.list(E.supplierInvoices, {}, K.supplierInvoices, wireSupplierInvoice),
        this.#client.list(
          E.supplierInvoiceFileConnections,
          {},
          K.supplierInvoiceFileConnections,
          wireSupplierInvoiceFileConnection,
        ),
      ]);
      const withFile = new Set(
        files.map((f) => f.SupplierInvoiceNumber).filter((n) => n !== undefined).map(String),
      );
      return rows
        .filter((r) => !(r.Cancelled ?? r.Cancel ?? false))
        .map((r) => mapSupplierInvoice(r, (n) => withFile.has(n)));
    });
  }

  async #supplierNumberByInvoice(): Promise<Map<string, string>> {
    const invoices = await this.#allSupplierInvoices();
    return new Map(invoices.map((i) => [i.givenNumber, i.supplierNumber]));
  }

  #customerNumberByInvoice(): Promise<Map<string, string>> {
    return this.#cached('customerNumberByInvoice', async () => {
      const rows = await this.#client.list(E.invoices, {}, K.invoices, wireCustomerInvoice);
      return new Map(rows.map((r) => [String(r.DocumentNumber), r.CustomerNumber]));
    });
  }

  #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#cache.get(key);
    if (existing) return existing as Promise<T>;
    const loading = load().catch((error: unknown) => {
      // A failed load must not be cached, or one transient error would poison
      // every later read in the run.
      this.#cache.delete(key);
      throw error;
    });
    this.#cache.set(key, loading);
    return loading;
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
