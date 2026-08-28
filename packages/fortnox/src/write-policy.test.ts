import { describe, expect, it } from 'vitest';
import { MockFortnoxAdapter } from './mock-adapter.js';
import { buildVoucherPayload, simulateVoucherCreate } from './payload.js';
import { RealFortnoxAdapter } from './real-adapter.js';
import {
  FortnoxWriteBlockedError,
  assertWriteAllowed,
  evaluateWriteGate,
  hashPayload,
  type WriteContext,
} from './write-policy.js';

/** A context where every condition is satisfied - only reachable in a future phase. */
const fullyApproved: WriteContext = {
  featureFlagEnabled: true,
  shadowMode: false,
  approvalDecisionId: 'approval-1',
  approvedPayloadHash: 'abc',
  payloadHash: 'abc',
  policy: { periodOpen: true, validationsPassed: true, clientWritesEnabled: true },
};

describe('Fortnox write gate', () => {
  it('blocks while shadow mode is active, whatever else is true', () => {
    const result = evaluateWriteGate({ ...fullyApproved, shadowMode: true });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('shadow_mode_active');
  });

  it.each([
    [{ featureFlagEnabled: false }, 'feature_flag_disabled'],
    [{ approvalDecisionId: null }, 'no_human_approval'],
    [{ approvedPayloadHash: null }, 'no_approved_payload_hash'],
    [{ policy: { periodOpen: false, validationsPassed: true, clientWritesEnabled: true } }, 'period_not_open'],
    [{ policy: { periodOpen: true, validationsPassed: false, clientWritesEnabled: true } }, 'validations_failed'],
    [{ policy: { periodOpen: true, validationsPassed: true, clientWritesEnabled: false } }, 'client_writes_disabled'],
  ] as const)('blocks when a single condition fails (%#)', (patch, reason) => {
    const result = evaluateWriteGate({ ...fullyApproved, ...patch } as WriteContext);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it('blocks when the payload changed after the human approved it', () => {
    const result = evaluateWriteGate({ ...fullyApproved, payloadHash: 'changed' });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('payload_changed_since_approval');
  });

  it('allows only the fully approved, non-shadow case', () => {
    expect(evaluateWriteGate(fullyApproved).allowed).toBe(true);
    expect(() => assertWriteAllowed(fullyApproved)).not.toThrow();
  });

  it('throws a typed error listing every reason', () => {
    try {
      assertWriteAllowed({ ...fullyApproved, shadowMode: true, featureFlagEnabled: false });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FortnoxWriteBlockedError);
      expect((error as FortnoxWriteBlockedError).reasons).toEqual([
        'shadow_mode_active',
        'feature_flag_disabled',
      ]);
    }
  });
});

describe('payload hashing', () => {
  it('is stable regardless of key order', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    expect(hashPayload({ Debit: 100 })).not.toBe(hashPayload({ Debit: 101 }));
  });
});

describe('voucher payload construction', () => {
  it('converts öre to kronor exactly once', () => {
    const payload = buildVoucherPayload({
      description: 'Test',
      transactionDate: '2025-08-31',
      series: 'A',
      rows: [
        { account: 5010, debit: 2500000, credit: 0, costCenter: 'ADM' },
        { account: 2990, debit: 0, credit: 2500000 },
      ],
    });
    expect(payload.Voucher.VoucherRows[0]?.Debit).toBe(25000);
    expect(payload.Voucher.VoucherRows[1]?.Credit).toBe(25000);
    expect(payload.Voucher.VoucherRows[0]?.CostCenter).toBe('ADM');
    // Empty optional fields are omitted rather than sent as null.
    expect(payload.Voucher.VoucherRows[1]).not.toHaveProperty('CostCenter');
  });

  it('marks a simulated request as never sent and names its endpoint', () => {
    const request = simulateVoucherCreate({
      description: 'Test',
      transactionDate: '2025-08-31',
      series: 'A',
      rows: [{ account: 5010, debit: 100, credit: 0 }],
    });
    expect(request.simulated).toBe(true);
    expect(request.endpoint).toBe('/3/vouchers');
    expect(request.method).toBe('POST');
    expect(request.note).toContain('never sent');
  });
});

describe('adapters refuse to write in phase 1', () => {
  const emptyDataset = {
    accounts: [],
    vouchers: [],
    suppliers: [],
    customers: [],
    supplierInvoices: [],
    customerInvoices: [],
    payments: [],
    bankTransactions: [],
    costCenters: [],
    projects: [],
    financialYears: [],
    voucherSeries: [],
    lockedThrough: null,
  };

  it('the mock adapter never writes', async () => {
    const adapter = new MockFortnoxAdapter(emptyDataset);
    await expect(
      adapter.createVoucher({
        Voucher: { Description: 'x', TransactionDate: '2025-08-01', VoucherSeries: 'A', VoucherRows: [] },
      }),
    ).rejects.toBeInstanceOf(FortnoxWriteBlockedError);
    await expect(adapter.lockPeriod('2025-08-31')).rejects.toBeInstanceOf(FortnoxWriteBlockedError);
  });

  it('the real adapter refuses to be constructed write-enabled while shadow mode is on', () => {
    expect(
      () =>
        new RealFortnoxAdapter({
          baseUrl: 'https://api.fortnox.se',
          tokenProvider: { getAccessToken: async () => 'token' },
          writesEnabled: true,
          shadowMode: true,
        }),
    ).toThrow(FortnoxWriteBlockedError);
  });

  it('the real adapter refuses a write with no write context', async () => {
    const adapter = new RealFortnoxAdapter({
      baseUrl: 'https://api.fortnox.se',
      tokenProvider: { getAccessToken: async () => 'token' },
      writesEnabled: false,
      shadowMode: true,
    });
    await expect(
      adapter.createVoucher({
        Voucher: { Description: 'x', TransactionDate: '2025-08-01', VoucherSeries: 'A', VoucherRows: [] },
      }),
    ).rejects.toBeInstanceOf(FortnoxWriteBlockedError);
  });

  it('the real adapter reports every unverified capability as unavailable', async () => {
    const adapter = new RealFortnoxAdapter({
      baseUrl: 'https://api.fortnox.se',
      tokenProvider: { getAccessToken: async () => 'token' },
      writesEnabled: false,
      shadowMode: true,
    });
    const report = await adapter.capabilities();
    expect(report.writesEnabled).toBe(false);
    expect(report.unavailable.map((u) => u.capability)).toContain('bank_transactions');
  });
});
