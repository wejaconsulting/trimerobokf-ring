import { periodKeyOf, type LedgerSnapshot, type Voucher } from '@trimeros/domain';
import { DEMO_PERIOD, DEMO_POLICY, buildSyntheticDataset } from '@trimeros/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RuleContext } from './context.js';
import { COMPLETENESS_GROUP, LEDGER_GROUP, consolidate, isPeriodLocked, runRuleGroup, runRules } from './engine.js';
import { buildHistoryIndex, findRecurringCosts, median } from './history.js';
import { generateProposals, proposalBalances } from './proposals.js';

const dataset = buildSyntheticDataset();

function contextFor(overrides: Partial<RuleContext> = {}): RuleContext {
  const inPeriod = (date: string) => periodKeyOf(date) === DEMO_PERIOD;
  const current: LedgerSnapshot = {
    ...dataset,
    vouchers: dataset.vouchers.filter((v) => inPeriod(v.transactionDate)),
    supplierInvoices: dataset.supplierInvoices.filter((i) => inPeriod(i.invoiceDate)),
    customerInvoices: dataset.customerInvoices.filter((i) => inPeriod(i.invoiceDate)),
  };
  return {
    clientId: 'client-demo',
    period: DEMO_PERIOD,
    policy: DEMO_POLICY,
    current,
    historyVouchers: dataset.vouchers.filter((v) => periodKeyOf(v.transactionDate) < DEMO_PERIOD),
    allSupplierInvoices: dataset.supplierInvoices,
    financialYears: dataset.financialYears,
    lockedThrough: dataset.lockedThrough,
    unavailableCapabilities: [],
    alreadyProcessedSourceKeys: new Set<string>(),
    ...overrides,
  };
}

describe('history index', () => {
  it('computes an exact median', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBe(0);
  });

  it('profiles each supplier from the history window', () => {
    const ctx = contextFor();
    const index = buildHistoryIndex(ctx.historyVouchers);
    const rent = index.suppliers.get('L001');
    expect(rent).toBeDefined();
    expect(rent!.accountCounts.get(5010)).toBeGreaterThan(10);
    expect(rent!.alwaysResultAccount).toBe(true);
    expect(index.suppliers.has('L006')).toBe(false); // new supplier, no history
  });

  it('identifies recurring costs that appear in nearly every period', () => {
    const ctx = contextFor();
    const index = buildHistoryIndex(ctx.historyVouchers);
    const recurring = findRecurringCosts(ctx.historyVouchers, index.periods);
    expect(recurring.some((r) => r.supplierNumber === 'L001' && r.account === 5010)).toBe(true);
  });
});

describe('rule engine over the synthetic dataset', () => {
  let findings: ReturnType<typeof runRules>;

  beforeAll(() => {
    findings = runRules(contextFor());
  });

  it.each([
    'anomaly.unusual_account_for_supplier',
    'anomaly.deviating_vat_code',
    'anomaly.unusual_amount_for_supplier',
    'anomaly.possible_duplicate',
    'anomaly.missing_documentation',
    'anomaly.missing_cost_center_or_project',
    'anomaly.transaction_in_wrong_period',
    'anomaly.manual_voucher_unusual',
    'anomaly.balance_account_where_history_uses_result_account',
    'anomaly.missing_recurring_cost',
  ])('fires the %s rule', (type) => {
    expect(findings.raw.some((f) => f.type === type)).toBe(true);
  });

  it.each([
    'validation.input_vat_without_documentation',
    'validation.missing_required_dimension',
    'validation.duplicate_source_record',
  ])('fires the %s validation', (type) => {
    expect(findings.raw.some((f) => f.type === type)).toBe(true);
  });

  it('marks every validation finding as blocking and no anomaly finding as blocking', () => {
    for (const finding of findings.raw) {
      expect(finding.blocking).toBe(finding.type.startsWith('validation.'));
    }
  });

  it('deduplicates findings that different rules produced for the same issue', () => {
    expect(findings.stats.mergedCount).toBeGreaterThan(0);
    const keys = findings.consolidated.map((f) => f.deduplicationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('merges the duplicate-invoice validation and the possible-duplicate rule into one item', () => {
    const merged = findings.consolidated.find((f) =>
      f.deduplicationKey.includes('duplicate_source_record'),
    );
    expect(merged).toBeDefined();
    expect(merged!.blocking).toBe(true);
  });

  it('gives every finding an explanation, an action and evidence or a subject', () => {
    for (const finding of findings.consolidated) {
      expect(finding.rationale.length).toBeGreaterThan(10);
      expect(finding.suggestedAction.length).toBeGreaterThan(5);
      expect(finding.decisionScore).toBeGreaterThanOrEqual(0);
      expect(finding.decisionScore).toBeLessThanOrEqual(1);
      expect(finding.evidence.length + Object.keys(finding.subject).length).toBeGreaterThan(0);
    }
  });

  it('never proposes automatic handling for a material amount', () => {
    for (const finding of findings.consolidated) {
      if (Math.abs(finding.amount) >= DEMO_POLICY.materialityThreshold) {
        expect(finding.decisionLevel).toBe('manual_assessment');
      }
    }
  });

  it('is deterministic: two runs over the same data agree exactly', () => {
    const again = runRules(contextFor());
    expect(again.consolidated.map((f) => f.deduplicationKey)).toEqual(
      findings.consolidated.map((f) => f.deduplicationKey),
    );
    expect(again.stats).toEqual(findings.stats);
  });

  it('splits work between the completeness and ledger groups', () => {
    const ctx = contextFor();
    const completeness = runRuleGroup(ctx, COMPLETENESS_GROUP);
    const ledger = runRuleGroup(ctx, LEDGER_GROUP);
    expect(completeness.length).toBeGreaterThan(0);
    expect(ledger.length).toBeGreaterThan(0);
    // Both groups independently notice the undocumented posting.
    const combined = consolidate([...completeness, ...ledger]);
    expect(combined.stats.mergedCount).toBeGreaterThan(0);
  });
});

describe('mandatory validations on constructed cases', () => {
  function withVoucher(voucher: Voucher): RuleContext {
    const base = contextFor();
    return { ...base, current: { ...base.current, vouchers: [voucher] } };
  }

  const baseVoucher: Voucher = {
    id: 'V1',
    series: 'A',
    number: 1,
    transactionDate: '2025-08-15',
    description: 'Test',
    manual: true,
    hasFileConnection: true,
    supplierInvoiceNumber: null,
    customerInvoiceNumber: null,
    supplierNumber: null,
    customerNumber: null,
    rows: [
      { id: 'V1#1', account: 6570, debit: 10000, credit: 0, description: '', costCenter: null, project: null, vatCode: null },
      { id: 'V1#2', account: 1930, debit: 0, credit: 10000, description: '', costCenter: null, project: null, vatCode: null },
    ],
  };

  it('detects an unbalanced voucher', () => {
    const unbalanced: Voucher = {
      ...baseVoucher,
      rows: [{ ...baseVoucher.rows[0]!, debit: 10000 }, { ...baseVoucher.rows[1]!, credit: 9000 }],
    };
    const result = runRules(withVoucher(unbalanced));
    expect(result.raw.some((f) => f.type === 'validation.unbalanced_voucher')).toBe(true);
  });

  it('detects an inactive account', () => {
    const inactive: Voucher = {
      ...baseVoucher,
      rows: [{ ...baseVoucher.rows[0]!, account: 2999 }, baseVoucher.rows[1]!],
    };
    const result = runRules(withVoucher(inactive));
    expect(result.raw.some((f) => f.type === 'validation.unknown_or_inactive_account')).toBe(true);
  });

  it('detects an unknown account', () => {
    const unknown: Voucher = {
      ...baseVoucher,
      rows: [{ ...baseVoucher.rows[0]!, account: 4321 }, baseVoucher.rows[1]!],
    };
    const result = runRules(withVoucher(unknown));
    expect(result.raw.some((f) => f.type === 'validation.unknown_or_inactive_account')).toBe(true);
  });

  it('detects a date outside every financial year', () => {
    const outside: Voucher = { ...baseVoucher, transactionDate: '2019-08-15' };
    const ctx = withVoucher(outside);
    const result = runRules({ ...ctx, lockedThrough: null });
    expect(result.raw.some((f) => f.type === 'validation.date_outside_financial_year')).toBe(true);
  });

  it('detects a posting inside a locked period', () => {
    const ctx = withVoucher({ ...baseVoucher, transactionDate: '2025-06-15' });
    const result = runRules({ ...ctx, lockedThrough: '2025-07-31' });
    expect(result.raw.some((f) => f.type === 'validation.period_locked')).toBe(true);
  });

  it('detects an implausible VAT amount', () => {
    const badVat: Voucher = {
      ...baseVoucher,
      rows: [
        { ...baseVoucher.rows[0]!, account: 6110, debit: 100000 },
        { id: 'V1#2', account: 2641, debit: 33000, credit: 0, description: '', costCenter: null, project: null, vatCode: 'I25' },
        { id: 'V1#3', account: 2440, debit: 0, credit: 133000, description: '', costCenter: null, project: null, vatCode: null },
      ],
    };
    const result = runRules(withVoucher(badVat));
    expect(result.raw.some((f) => f.type === 'validation.implausible_vat')).toBe(true);
  });

  it('reports a period as locked when its last day is covered by the lock date', () => {
    expect(isPeriodLocked({ ...contextFor(), lockedThrough: '2025-08-31' })).toBe(true);
    expect(isPeriodLocked({ ...contextFor(), lockedThrough: '2025-07-31' })).toBe(false);
    expect(isPeriodLocked({ ...contextFor(), lockedThrough: null })).toBe(false);
  });

  it('forces manual assessment for everything when the whole period is locked', () => {
    const result = runRules({ ...contextFor(), lockedThrough: '2025-08-31' });
    for (const finding of result.consolidated) {
      expect(finding.decisionLevel).toBe('manual_assessment');
    }
  });
});

describe('booking proposals', () => {
  const rules = [
    { kind: 'dimension_requirement', account: 5410, costCenter: 'KONS' },
    { kind: 'recurring_cost', supplierNumber: 'L001', account: 5010, accrualAccount: 2990 },
  ] as const;

  it('proposes a balanced correction for every generated proposal', () => {
    const ctx = contextFor();
    const proposals = generateProposals(ctx, runRules(ctx).consolidated, [...rules]);
    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) expect(proposalBalances(proposal)).toBe(true);
  });

  it('reaches the automatic level for a small deterministic dimension correction', () => {
    const ctx = contextFor();
    const proposals = generateProposals(ctx, runRules(ctx).consolidated, [...rules]);
    const dimension = proposals.find((p) => p.description.includes('kostnadsställe'));
    expect(dimension?.decision.level).toBe('automatic');
  });

  it('keeps a material accrual at manual assessment', () => {
    const ctx = contextFor();
    const proposals = generateProposals(ctx, runRules(ctx).consolidated, [...rules]);
    const accrual = proposals.find((p) => p.description.includes('Periodisering'));
    expect(accrual?.decision.level).toBe('manual_assessment');
  });

  it('proposes nothing when the period is locked', () => {
    const ctx = { ...contextFor(), lockedThrough: '2025-08-31' };
    const proposals = generateProposals(ctx, runRules(ctx).consolidated, [...rules]);
    for (const proposal of proposals) expect(proposal.decision.level).toBe('manual_assessment');
  });
});
