import { describe, expect, it } from 'vitest';
import {
  buildDeduplicationKey,
  consolidateFindings,
  isBlockingType,
  maxSeverity,
  type FindingDraft,
} from './findings.js';

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    type: 'anomaly.missing_documentation',
    severity: 'medium',
    subject: { voucherId: 'LF1' },
    amount: 1000,
    description: 'Saknat underlag',
    rationale: 'Ingen fil kopplad.',
    suggestedAction: 'Begär underlag.',
    evidence: [{ kind: 'voucher', ref: 'LF1' }],
    decisionLevel: 'review',
    decisionScore: 0.6,
    decisionReasons: ['a'],
    requiresConsultant: true,
    blocking: false,
    deduplicationKey: 'c|2025-08|missing_documentation|lf1',
    ruleId: 'anomaly.missing_documentation',
    ruleVersion: 'anomaly.missing_documentation@1.0.0',
    ...overrides,
  };
}

describe('finding consolidation', () => {
  it('collapses two rules that found the same issue into one finding', () => {
    const result = consolidateFindings([
      draft(),
      draft({
        type: 'validation.input_vat_without_documentation',
        ruleId: 'validation.input_vat_documentation',
        ruleVersion: 'validation.input_vat_documentation@1.0.0',
        blocking: true,
        severity: 'high',
        decisionLevel: 'manual_assessment',
        decisionScore: 0.4,
        evidence: [{ kind: 'voucher_row', ref: 'LF1#2' }],
      }),
    ]);

    expect(result).toHaveLength(1);
    const merged = result[0]!;
    expect(merged.blocking).toBe(true);
    expect(merged.severity).toBe('high');
    // The most restrictive level and the lowest score survive - the safe side.
    expect(merged.decisionLevel).toBe('manual_assessment');
    expect(merged.decisionScore).toBe(0.4);
    expect(merged.evidence).toHaveLength(2);
  });

  it('keeps findings with different deduplication keys apart', () => {
    const result = consolidateFindings([
      draft(),
      draft({ subject: { voucherId: 'LF2' }, deduplicationKey: 'c|2025-08|missing_documentation|lf2' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('is idempotent: consolidating twice changes nothing', () => {
    const once = consolidateFindings([draft(), draft()]);
    const twice = consolidateFindings(once);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.deduplicationKey).toBe(once[0]?.deduplicationKey);
  });

  it('sorts the most severe, largest findings first', () => {
    const result = consolidateFindings([
      draft({ severity: 'low', deduplicationKey: 'a', amount: 100 }),
      draft({ severity: 'critical', deduplicationKey: 'b', amount: 50 }),
      draft({ severity: 'low', deduplicationKey: 'c', amount: 900 }),
    ]);
    expect(result.map((f) => f.deduplicationKey)).toEqual(['b', 'c', 'a']);
  });

  it('builds a deduplication key that excludes the rule id', () => {
    const key = buildDeduplicationKey({
      clientId: 'C1',
      periodKey: '2025-08',
      issueClass: 'missing_documentation',
      subject: { voucherId: 'LF9' },
    });
    expect(key).toBe('c1|2025-08|missing_documentation|lf9');
    expect(key).not.toContain('anomaly');
  });

  it('treats every validation type as blocking and no anomaly type as blocking', () => {
    expect(isBlockingType('validation.unbalanced_voucher')).toBe(true);
    expect(isBlockingType('anomaly.possible_duplicate')).toBe(false);
  });

  it('picks the higher severity', () => {
    expect(maxSeverity('low', 'critical')).toBe('critical');
    expect(maxSeverity('high', 'medium')).toBe('high');
  });
});
