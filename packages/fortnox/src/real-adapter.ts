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
import { UNVERIFIED_CAPABILITIES } from './endpoints.js';
import type { FortnoxCapabilityReport, FortnoxReadPort, FortnoxWritePort, VoucherCreatePayload } from './ports.js';
import { FortnoxWriteBlockedError, type WriteContext, assertWriteAllowed } from './write-policy.js';

/**
 * The real Fortnox adapter.
 *
 * NOT used anywhere in phase 1's runtime paths - the composition root only ever
 * constructs the mock adapter (see `createFortnoxAdapter`). It exists so the
 * boundary, the auth model and the disabled write path are all reviewable now
 * rather than invented later under time pressure.
 *
 * Security properties this class is responsible for:
 *  - The access token is supplied by an injected provider and is never logged,
 *    never returned, and never placed in an object that reaches a model.
 *  - Every write method calls `assertWriteAllowed` first. With phase 1's
 *    configuration that call always throws.
 */

export interface AccessTokenProvider {
  /** Returns a bearer token. Implementations must not log or persist it. */
  getAccessToken(): Promise<string>;
}

export interface RealFortnoxAdapterOptions {
  readonly baseUrl: string;
  readonly tokenProvider: AccessTokenProvider;
  /** Must stay false in phase 1. */
  readonly writesEnabled: boolean;
  readonly shadowMode: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const NOT_IMPLEMENTED_READ =
  'Read path not implemented in phase 1: the mock adapter is the only supported adapter.';

export class RealFortnoxAdapter implements FortnoxReadPort, FortnoxWritePort {
  readonly adapterName = 'fortnox-real';
  readonly #options: RealFortnoxAdapterOptions;

  constructor(options: RealFortnoxAdapterOptions) {
    if (options.writesEnabled) {
      // Defence in depth: refuse to even construct a write-enabled adapter
      // while the global shadow-mode switch is on.
      if (options.shadowMode) {
        throw new FortnoxWriteBlockedError(['writes_enabled_while_shadow_mode_active']);
      }
    }
    this.#options = options;
  }

  async capabilities(): Promise<FortnoxCapabilityReport> {
    return {
      adapterName: this.adapterName,
      mode: this.#options.writesEnabled ? 'real_read_write' : 'real_read_only',
      writesEnabled: this.#options.writesEnabled,
      available: [],
      unavailable: [
        ...Object.entries(UNVERIFIED_CAPABILITIES).map(([capability, reason]) => ({
          capability,
          reason,
        })),
        {
          capability: 'all_reads',
          reason: NOT_IMPLEMENTED_READ,
        },
      ],
    };
  }

  // --- reads --------------------------------------------------------------
  // Phase 1 deliberately ships the boundary without live HTTP calls. Wiring
  // these up is a phase-2 task that requires a sandbox Fortnox account and a
  // field-by-field verification of every response shape.

  listFinancialYears(): Promise<FinancialYear[]> {
    return this.#notImplemented('financialYears');
  }
  listAccounts(_financialYearId: string): Promise<Account[]> {
    return this.#notImplemented('accounts');
  }
  listVoucherSeries(): Promise<VoucherSeries[]> {
    return this.#notImplemented('voucherSeries');
  }
  listVouchers(_period: PeriodKey): Promise<Voucher[]> {
    return this.#notImplemented('vouchers');
  }
  listSuppliers(): Promise<Supplier[]> {
    return this.#notImplemented('suppliers');
  }
  listCustomers(): Promise<Customer[]> {
    return this.#notImplemented('customers');
  }
  listSupplierInvoices(_period: PeriodKey): Promise<SupplierInvoice[]> {
    return this.#notImplemented('supplierInvoices');
  }
  listCustomerInvoices(_period: PeriodKey): Promise<CustomerInvoice[]> {
    return this.#notImplemented('customerInvoices');
  }
  listPayments(_period: PeriodKey): Promise<Payment[]> {
    return this.#notImplemented('payments');
  }
  listBankTransactions(_period: PeriodKey): Promise<BankTransaction[]> {
    return Promise.reject(
      new Error(`Unavailable: ${UNVERIFIED_CAPABILITIES.bank_transactions ?? 'unverified'}`),
    );
  }
  listCostCenters(): Promise<CostCenter[]> {
    return this.#notImplemented('costCenters');
  }
  listProjects(): Promise<Project[]> {
    return this.#notImplemented('projects');
  }
  getLockedPeriod(): Promise<{ lockedThrough: IsoDate | null }> {
    return this.#notImplemented('lockedPeriod');
  }

  // --- writes -------------------------------------------------------------

  async createVoucher(payload: VoucherCreatePayload, context?: WriteContext): Promise<{ id: string }> {
    this.#guardWrite(payload, context);
    // Unreachable in phase 1: #guardWrite always throws under this config.
    throw new FortnoxWriteBlockedError(['write_transport_not_implemented']);
  }

  async lockPeriod(_through: IsoDate, context?: WriteContext): Promise<void> {
    this.#guardWrite({ lockPeriod: _through }, context);
    throw new FortnoxWriteBlockedError([
      'write_transport_not_implemented',
      'locked_period_write_unverified',
    ]);
  }

  #guardWrite(payload: unknown, context: WriteContext | undefined): void {
    if (!context) {
      throw new FortnoxWriteBlockedError(['no_write_context_supplied']);
    }
    void payload;
    assertWriteAllowed(context);
  }

  #notImplemented<T>(what: string): Promise<T> {
    return Promise.reject(new Error(`${NOT_IMPLEMENTED_READ} (${what})`));
  }
}
