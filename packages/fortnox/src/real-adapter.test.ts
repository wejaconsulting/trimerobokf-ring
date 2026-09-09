import type { HttpFetch, HttpRequestInit, HttpResponse } from '@trimeros/domain';
import { describe, expect, it } from 'vitest';
import { FortnoxApiError, FortnoxHttpClient, FortnoxResponseShapeError } from './http/client.js';
import { SlidingWindowRateLimiter } from './http/rate-limiter.js';
import { RealFortnoxAdapter } from './real-adapter.js';
import { kronorToOre } from './wire.js';
import { FortnoxWriteBlockedError, hashPayload } from './write-policy.js';

/**
 * Contract tests for the real adapter against a fake Fortnox.
 *
 * The fake answers with the response shapes documented in
 * docs/fortnox-capability-matrix.md ("Response shapes"). What is asserted here
 * is the adapter's side of the contract: the bearer header, pagination, the
 * öre conversion, the identity of a voucher across financial years, and that
 * no token ever leaks into an error.
 */

interface Call {
  readonly url: string;
  readonly init: HttpRequestInit;
}

function json(status: number, body: unknown): HttpResponse {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

function meta(page: number, totalPages: number) {
  return { '@TotalPages': totalPages, '@CurrentPage': page, '@TotalResources': 0 };
}

/** A fake Fortnox with one financial year, two vouchers (one on page 2) and a sub-ledger. */
function fakeFortnox(overrides: Partial<Record<string, (url: URL) => HttpResponse>> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, (url: URL) => HttpResponse> = {
    '/3/financialyears': () =>
      json(200, {
        FinancialYears: [
          { Id: 7, FromDate: '2025-01-01', ToDate: '2025-12-31', AccountingMethod: 'ACCRUAL' },
          { Id: 6, FromDate: '2024-01-01', ToDate: '2024-12-31' },
        ],
        MetaInformation: meta(1, 1),
      }),
    '/3/accounts': (url) =>
      json(200, {
        Accounts: [
          { Number: 5010, Description: 'Lokalhyra', Active: true, VATCode: 'MP1', CostCenterSettings: 'MANDATORY' },
          { Number: 2440, Description: 'Leverantörsskulder', Active: true, VATCode: '' },
        ],
        MetaInformation: meta(Number(url.searchParams.get('page')), 1),
      }),
    '/3/voucherseries': () =>
      json(200, { VoucherSeriesCollection: [{ Code: 'A', Description: 'Manuell', Manual: true, Year: 7 }] }),
    '/3/vouchers': (url) => {
      const page = Number(url.searchParams.get('page'));
      if (page === 1) {
        return json(200, {
          Vouchers: [
            { VoucherSeries: 'A', VoucherNumber: 12, Year: 7, TransactionDate: '2025-08-05', Description: 'Hyra', ReferenceType: 'SUPPLIERINVOICE', ReferenceNumber: '1001' },
          ],
          MetaInformation: meta(1, 2),
        });
      }
      return json(200, {
        Vouchers: [
          { VoucherSeries: 'B', VoucherNumber: 3, Year: 7, TransactionDate: '2025-08-20', Description: 'Kaffe', ReferenceType: 'MANUAL' },
        ],
        MetaInformation: meta(2, 2),
      });
    },
    '/3/vouchers/A/12': () =>
      json(200, {
        Voucher: {
          VoucherSeries: 'A', VoucherNumber: 12, Year: 7, TransactionDate: '2025-08-05', Description: 'Hyra',
          ReferenceType: 'SUPPLIERINVOICE', ReferenceNumber: '1001',
          VoucherRows: [
            { Account: 5010, Debit: 12500.5, Credit: 0, CostCenter: 'KONS' },
            { Account: 2440, Debit: 0, Credit: 12500.5 },
            { Account: 9999, Debit: 1, Credit: 0, Removed: true },
          ],
        },
      }),
    '/3/vouchers/B/3': () =>
      json(200, {
        Voucher: {
          VoucherSeries: 'B', VoucherNumber: 3, Year: 7, TransactionDate: '2025-08-20', Description: 'Kaffe', ReferenceType: 'MANUAL',
          VoucherRows: [
            { Account: 6540, Debit: 199, Credit: 0, TransactionInformation: 'Fika' },
            { Account: 1930, Debit: 0, Credit: 199 },
          ],
        },
      }),
    '/3/voucherfileconnections': () =>
      json(200, { VoucherFileConnections: [{ FileId: 'f1', VoucherSeries: 'A', VoucherNumber: '12', VoucherYear: 7 }] }),
    '/3/suppliers': () => json(200, { Suppliers: [{ SupplierNumber: 'L001', Name: 'Fastighets AB', OrganisationNumber: '556000-0001' }] }),
    '/3/customers': () => json(200, { Customers: [{ CustomerNumber: 'K1', Name: 'Kund AB' }] }),
    '/3/supplierinvoices': () =>
      json(200, {
        SupplierInvoices: [
          { GivenNumber: '1001', SupplierNumber: 'L001', SupplierName: 'Fastighets AB', InvoiceDate: '2025-08-01', DueDate: '2025-08-31', Total: '12500.50', Booked: true, Vouchers: [{ Number: 12, Year: 7, Series: 'A' }] },
          { GivenNumber: '1002', SupplierNumber: 'L001', InvoiceDate: '2025-07-01', Total: '100.00', Booked: false },
          { GivenNumber: '1003', SupplierNumber: 'L001', InvoiceDate: '2025-08-15', Total: '50.00', Cancelled: true },
        ],
      }),
    '/3/supplierinvoicefileconnections': () =>
      json(200, { SupplierInvoiceFileConnections: [{ FileId: 'f2', SupplierInvoiceNumber: '1001' }] }),
    '/3/invoices': () =>
      json(200, {
        Invoices: [
          { DocumentNumber: 501, CustomerNumber: 'K1', CustomerName: 'Kund AB', InvoiceDate: '2025-08-10', DueDate: '2025-09-09', Total: 1000, Balance: 0, Booked: true, VoucherNumber: 9, VoucherSeries: 'F', VoucherYear: 7 },
        ],
      }),
    '/3/supplierinvoicepayments': () =>
      json(200, { SupplierInvoicePayments: [{ Number: 1, InvoiceNumber: '1001', PaymentDate: '2025-08-30', Amount: 12500.5, Booked: true }] }),
    '/3/invoicepayments': () =>
      json(200, { InvoicePayments: [{ Number: '2', InvoiceNumber: 501, PaymentDate: '2025-09-02', Amount: 1000, Booked: true }] }),
    '/3/costcenters': () => json(200, { CostCenters: [{ Code: 'KONS', Description: 'Konsult', Active: true }] }),
    '/3/projects': () => json(200, { Projects: [{ ProjectNumber: '10', Description: 'Projekt', Status: 'COMPLETED' }] }),
    '/3/settings/lockedperiod': () => json(200, { LockedPeriod: { EndDate: '2025-06-30' } }),
    ...overrides,
  };

  const fetchImpl: HttpFetch = async (rawUrl, init = {}) => {
    calls.push({ url: rawUrl, init });
    const url = new URL(rawUrl);
    const route = routes[url.pathname];
    if (!route) return json(404, { ErrorInformation: { Error: 1, Message: 'Not found', Code: 2000422 } });
    return route(url);
  };
  return { fetchImpl, calls };
}

function adapter(fetchImpl: HttpFetch, options: { writesEnabled?: boolean; shadowMode?: boolean } = {}) {
  const limiter = new SlidingWindowRateLimiter({ maxRequests: 1000, windowMs: 1, now: () => 0, sleep: async () => undefined });
  return new RealFortnoxAdapter({
    baseUrl: 'https://api.fortnox.example',
    tokenProvider: { getAccessToken: async () => 'secret-access-token' },
    writesEnabled: options.writesEnabled ?? false,
    shadowMode: options.shadowMode ?? true,
    client: new FortnoxHttpClient({
      baseUrl: 'https://api.fortnox.example',
      tokenProvider: { getAccessToken: async () => 'secret-access-token' },
      fetchImpl,
      rateLimiter: limiter,
      sleep: async () => undefined,
      maxRetries: 1,
    }),
  });
}

describe('kronorToOre', () => {
  it('converts decimal kronor to integer öre without float drift', () => {
    expect(kronorToOre(12500.5)).toBe(1250050);
    expect(kronorToOre('12500.50')).toBe(1250050);
    expect(kronorToOre('0.1')).toBe(10);
    expect(kronorToOre(0.1 + 0.2)).toBe(30);
    expect(kronorToOre('-99.99')).toBe(-9999);
    expect(kronorToOre('1 234,56'.replace(' ', ''))).toBe(123456);
    expect(kronorToOre(0)).toBe(0);
  });
});

describe('RealFortnoxAdapter reads', () => {
  it('sends a bearer token and JSON accept header on every call', async () => {
    const fake = fakeFortnox();
    await adapter(fake.fetchImpl).listFinancialYears();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init.headers?.Authorization).toBe('Bearer secret-access-token');
    expect(fake.calls[0]?.init.headers?.Accept).toBe('application/json');
  });

  it('maps financial years and accounts, asking for the account plan of the given year', async () => {
    const fake = fakeFortnox();
    const a = adapter(fake.fetchImpl);
    const years = await a.listFinancialYears();
    expect(years.map((y) => y.id)).toEqual(['6', '7']);

    const accounts = await a.listAccounts('7');
    expect(accounts).toEqual([
      { number: 5010, description: 'Lokalhyra', type: 'cost', active: true, vatCode: 'MP1', costCenterRequired: true, projectRequired: false },
      { number: 2440, description: 'Leverantörsskulder', type: 'liability', active: true, vatCode: null, costCenterRequired: false, projectRequired: false },
    ]);
    const accountsCall = fake.calls.find((c) => c.url.includes('/3/accounts'));
    expect(new URL(accountsCall?.url ?? '').searchParams.get('financialyear')).toBe('7');
    expect(new URL(accountsCall?.url ?? '').searchParams.get('limit')).toBe('500');
  });

  it('fetches every page of the voucher list, then each voucher with its rows', async () => {
    const fake = fakeFortnox();
    const vouchers = await adapter(fake.fetchImpl).listVouchers('2025-08');

    expect(vouchers.map((v) => v.id)).toEqual(['7-A-12', '7-B-3']);
    const listCalls = fake.calls.filter((c) => new URL(c.url).pathname === '/3/vouchers');
    expect(listCalls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
    expect(new URL(listCalls[0]?.url ?? '').searchParams.get('fromdate')).toBe('2025-08-01');
    expect(new URL(listCalls[0]?.url ?? '').searchParams.get('todate')).toBe('2025-08-31');
    expect(new URL(listCalls[0]?.url ?? '').searchParams.get('financialyear')).toBe('7');

    const rent = vouchers[0];
    expect(rent).toMatchObject({
      series: 'A',
      number: 12,
      transactionDate: '2025-08-05',
      manual: false,
      hasFileConnection: true,
      supplierInvoiceNumber: '1001',
      supplierNumber: 'L001',
    });
    // Amounts in öre, the removed row dropped, the cost center kept.
    expect(rent?.rows).toEqual([
      { id: '7-A-12-1', account: 5010, debit: 1250050, credit: 0, description: '', costCenter: 'KONS', project: null, vatCode: null },
      { id: '7-A-12-2', account: 2440, debit: 0, credit: 1250050, description: '', costCenter: null, project: null, vatCode: null },
    ]);
    expect(vouchers[1]).toMatchObject({ manual: true, hasFileConnection: false, supplierNumber: null });
    expect(vouchers[1]?.rows[0]?.description).toBe('Fika');
  });

  it('filters sub-ledgers by period and drops cancelled invoices', async () => {
    const fake = fakeFortnox();
    const a = adapter(fake.fetchImpl);
    const invoices = await a.listSupplierInvoices('2025-08');
    expect(invoices).toEqual([
      {
        id: '1001', givenNumber: '1001', supplierNumber: 'L001', supplierName: 'Fastighets AB',
        invoiceDate: '2025-08-01', dueDate: '2025-08-31', total: 1250050, vatAmount: 0, currency: 'SEK',
        booked: true, hasFileConnection: true, voucherId: '7-A-12',
      },
    ]);
    expect(await a.listCustomerInvoices('2025-08')).toEqual([
      {
        id: '501', documentNumber: '501', customerNumber: 'K1', customerName: 'Kund AB', invoiceDate: '2025-08-10',
        dueDate: '2025-09-09', total: 100000, vatAmount: 0, currency: 'SEK', booked: true, fullyPaid: true, voucherId: '7-F-9',
      },
    ]);
    const payments = await a.listPayments('2025-08');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ kind: 'supplier_invoice_payment', invoiceId: '1001', amount: 1250050 });
    expect(await a.listPayments('2025-09')).toHaveLength(1);
  });

  it('maps dimensions, counterparties and the locked period', async () => {
    const fake = fakeFortnox();
    const a = adapter(fake.fetchImpl);
    expect(await a.listCostCenters()).toEqual([{ code: 'KONS', description: 'Konsult', active: true }]);
    expect(await a.listProjects()).toEqual([{ projectNumber: '10', description: 'Projekt', status: 'completed' }]);
    expect(await a.listSuppliers()).toEqual([{ supplierNumber: 'L001', name: 'Fastighets AB', organisationNumber: '556000-0001', active: true }]);
    expect(await a.listCustomers()).toEqual([{ customerNumber: 'K1', name: 'Kund AB', organisationNumber: null, active: true }]);
    expect(await a.getLockedPeriod()).toEqual({ lockedThrough: '2025-06-30' });
  });

  it('treats a missing locked-period resource as "not locked"', async () => {
    const fake = fakeFortnox({ '/3/settings/lockedperiod': () => json(404, {}) });
    expect(await adapter(fake.fetchImpl).getLockedPeriod()).toEqual({ lockedThrough: null });
  });

  it('caches reference data within one adapter instance', async () => {
    const fake = fakeFortnox();
    const a = adapter(fake.fetchImpl);
    await a.listVouchers('2025-08');
    await a.listVouchers('2025-07');
    const yearCalls = fake.calls.filter((c) => new URL(c.url).pathname === '/3/financialyears');
    expect(yearCalls).toHaveLength(1);
  });

  it('reports bank transactions as unavailable rather than guessing', async () => {
    await expect(adapter(fakeFortnox().fetchImpl).listBankTransactions('2025-08')).rejects.toThrow(/Unavailable/);
    const caps = await adapter(fakeFortnox().fetchImpl).capabilities();
    expect(caps.mode).toBe('real_read_only');
    expect(caps.available).toContain('vouchers');
    expect(caps.available).not.toContain('voucher_create');
    expect(caps.unavailable.map((u) => u.capability)).toContain('bank_transactions');
  });
});

describe('RealFortnoxAdapter errors', () => {
  it('turns a Fortnox error body into a typed error that never carries the token', async () => {
    const fake = fakeFortnox({
      '/3/accounts': () => json(403, { ErrorInformation: { Error: 1, Message: 'Saknar behörighet', Code: 2000663 } }),
    });
    try {
      await adapter(fake.fetchImpl).listAccounts('7');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FortnoxApiError);
      const e = error as FortnoxApiError;
      expect(e.status).toBe(403);
      expect(e.fortnoxCode).toBe(2000663);
      expect(e.message).not.toContain('secret-access-token');
      expect(JSON.stringify(e)).not.toContain('secret-access-token');
    }
  });

  it('retries a 429 once and then succeeds', async () => {
    let attempts = 0;
    const fake = fakeFortnox({
      '/3/costcenters': () => {
        attempts += 1;
        return attempts === 1
          ? json(429, { ErrorInformation: { Message: 'Too many requests' } })
          : json(200, { CostCenters: [] });
      },
    });
    expect(await adapter(fake.fetchImpl).listCostCenters()).toEqual([]);
    expect(attempts).toBe(2);
  });

  it('rejects a response whose shape drifted instead of returning garbage', async () => {
    const fake = fakeFortnox({ '/3/financialyears': () => json(200, { FinancialYears: [{ Id: 'seven' }] }) });
    await expect(adapter(fake.fetchImpl).listFinancialYears()).rejects.toBeInstanceOf(FortnoxResponseShapeError);
  });
});

describe('RealFortnoxAdapter writes', () => {
  const payload = {
    Voucher: {
      Description: 'Omkontering',
      TransactionDate: '2025-08-31',
      VoucherSeries: 'A',
      VoucherRows: [
        { Account: 5010, Debit: 100, Credit: 0, CostCenter: 'KONS' },
        { Account: 5010, Debit: 0, Credit: 100 },
      ],
    },
  };
  const approved = {
    featureFlagEnabled: true,
    shadowMode: false,
    approvalDecisionId: 'approval-1',
    approvedPayloadHash: hashPayload(payload),
    payloadHash: hashPayload(payload),
    policy: { periodOpen: true, validationsPassed: true, clientWritesEnabled: true },
  };

  it('refuses to be constructed write-enabled under shadow mode', () => {
    expect(() => adapter(fakeFortnox().fetchImpl, { writesEnabled: true, shadowMode: true })).toThrow(
      FortnoxWriteBlockedError,
    );
  });

  it('never posts while the adapter is read-only, even with a fully approved context', async () => {
    const fake = fakeFortnox();
    await expect(adapter(fake.fetchImpl).createVoucher(payload, approved)).rejects.toThrow(/adapter_writes_disabled/);
    expect(fake.calls.filter((c) => c.init.method === 'POST')).toHaveLength(0);
  });

  it('never posts without a write context or with a failing gate', async () => {
    const fake = fakeFortnox();
    const a = adapter(fake.fetchImpl, { writesEnabled: true, shadowMode: false });
    await expect(a.createVoucher(payload)).rejects.toThrow(/no_write_context_supplied/);
    await expect(a.createVoucher(payload, { ...approved, payloadHash: 'other' })).rejects.toThrow(
      /payload_changed_since_approval/,
    );
    expect(fake.calls.filter((c) => c.init.method === 'POST')).toHaveLength(0);
  });

  it('posts the exact payload once the gate passes and returns the Fortnox reference', async () => {
    const fake = fakeFortnox({
      '/3/vouchers': (url) =>
        json(201, { Voucher: { VoucherSeries: 'A', VoucherNumber: 77, Year: Number(url.searchParams.get('financialyear')) } }),
    });
    const a = adapter(fake.fetchImpl, { writesEnabled: true, shadowMode: false });
    const result = await a.createVoucher(payload, approved);
    expect(result).toEqual({ id: '7-A-77', reference: 'A77' });
    const post = fake.calls.find((c) => c.init.method === 'POST');
    expect(post?.url).toContain('/3/vouchers?financialyear=7');
    expect(JSON.parse(String(post?.init.body))).toEqual(payload);
    expect(post?.init.headers?.['Content-Type']).toBe('application/json');
  });

  it('never locks a period, whatever the context says', async () => {
    const a = adapter(fakeFortnox().fetchImpl, { writesEnabled: true, shadowMode: false });
    await expect(a.lockPeriod('2025-08-31', approved)).rejects.toThrow(/locked_period_write_unverified/);
  });
});

describe('supplierNameMatcher', () => {
  const suppliers = [
    { supplierNumber: 'L001', name: 'Fastighets AB Norr', organisationNumber: null, active: true },
    { supplierNumber: 'L007', name: 'Städbolaget Ren & Fin AB', organisationNumber: null, active: true },
    { supplierNumber: 'L009', name: 'Ren & Fin AB', organisationNumber: null, active: true },
    { supplierNumber: 'L010', name: 'AB', organisationNumber: null, active: true },
  ];

  it('resolves a voucher text to the one supplier whose name it contains', async () => {
    const { supplierNameMatcher } = await import('./wire.js');
    const match = supplierNameMatcher(suppliers);
    expect(match('Leverantörsfaktura Fastighets AB Norr (förskott)')).toBe('L001');
    expect(match('Hyra')).toBeNull();
  });

  it('prefers the longest name when one contains the other, and refuses ambiguity', async () => {
    const { supplierNameMatcher } = await import('./wire.js');
    const match = supplierNameMatcher(suppliers);
    expect(match('Städbolaget Ren & Fin AB städning augusti')).toBe('L007');
    expect(match('Fastighets AB Norr och Ren & Fin AB')).toBeNull();
  });

  it('ignores names too short to be meaningful', async () => {
    const { supplierNameMatcher } = await import('./wire.js');
    expect(supplierNameMatcher(suppliers)('Kaffe AB')).toBeNull();
  });
});
