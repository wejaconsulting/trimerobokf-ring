import type { MockFortnoxAdapter } from './mock-adapter.js';
import type { FortnoxCapabilityReport, FortnoxReadPort } from './ports.js';

/**
 * Data-source resolution.
 *
 * A firm runs many clients, and each one is either connected to a real Fortnox
 * account, running on the synthetic demo dataset, or not connected at all. The
 * workflow engine therefore does not hold one adapter; it asks a resolver for
 * the client's data source at the start of every close run.
 *
 * `kind: 'none'` is a first-class answer. It makes "this client has no data
 * source" a blocked readiness step with a Swedish explanation, rather than a
 * silent run on demo data that looks like a real one.
 */

export type FortnoxDataSourceKind = 'mock' | 'real' | 'none';

export interface FortnoxDataSource {
  readonly kind: FortnoxDataSourceKind;
  readonly port: FortnoxReadPort;
  /** Consultant-facing label: company name for a real account, "demodata" for mock. */
  readonly label: string;
  /** Why no source could be resolved, when `kind` is `none`. */
  readonly reason: string | null;
}

export interface FortnoxPortResolver {
  resolve(scope: { readonly tenantId: string; readonly clientId: string }): Promise<FortnoxDataSource>;
}

export function isPortResolver(value: FortnoxReadPort | FortnoxPortResolver): value is FortnoxPortResolver {
  return typeof (value as FortnoxPortResolver).resolve === 'function' && !('adapterName' in value);
}

/** Every client resolves to the same port - what tests and the smoke test use. */
export function staticResolver(port: FortnoxReadPort, kind: FortnoxDataSourceKind = 'mock'): FortnoxPortResolver {
  return {
    resolve: async () => ({
      kind,
      port,
      label: kind === 'mock' ? 'Demodata (mock-adapter)' : port.adapterName,
      reason: null,
    }),
  };
}

export function mockDataSource(port: MockFortnoxAdapter): FortnoxDataSource {
  return { kind: 'mock', port, label: 'Demodata (mock-adapter)', reason: null };
}

/**
 * The port a client without a data source gets.
 *
 * Every read rejects with the reason, so a step that somehow runs past the
 * readiness check still cannot produce numbers out of nothing.
 */
export function unavailableDataSource(reason: string): FortnoxDataSource {
  const reject = <T>(): Promise<T> => Promise.reject(new Error(reason));
  const port: FortnoxReadPort = {
    adapterName: 'unavailable',
    capabilities: async (): Promise<FortnoxCapabilityReport> => ({
      adapterName: 'unavailable',
      mode: 'unavailable',
      writesEnabled: false,
      available: [],
      unavailable: [{ capability: 'all', reason }],
    }),
    listFinancialYears: reject,
    listAccounts: reject,
    listVoucherSeries: reject,
    listVouchers: reject,
    listSuppliers: reject,
    listCustomers: reject,
    listSupplierInvoices: reject,
    listCustomerInvoices: reject,
    listPayments: reject,
    listBankTransactions: reject,
    listCostCenters: reject,
    listProjects: reject,
    getLockedPeriod: reject,
  };
  return { kind: 'none', port, label: 'Ingen datakälla', reason };
}
