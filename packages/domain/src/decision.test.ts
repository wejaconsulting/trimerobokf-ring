import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DECISION_THRESHOLDS,
  computeDecisionScore,
  decide,
  materialitySignal,
  totalWeight,
  type DecisionGates,
  type DecisionSignals,
} from './decision.js';
import { sek } from './money.js';

const perfectSignals: DecisionSignals = {
  documentCompleteness: 1,
  deterministicRuleMatch: 1,
  historicalConsistency: 1,
  counterpartyIdentityMatch: 1,
  amountConsistency: 1,
  vatConsistency: 1,
  dimensionConsistency: 1,
  duplicateRisk: 1,
  reconciliationImpact: 1,
  materiality: 1,
};

const openGates: DecisionGates = {
  deterministicRuleMatched: true,
  validationsPassed: true,
  requiredDocumentationPresent: true,
  periodOpen: true,
  withinAmountLimit: true,
  noConflictingFinding: true,
  vatTreatmentUncertain: false,
  requiresProfessionalJudgement: false,
  periodLocked: false,
  materialAmount: false,
  conflictingRules: false,
  missingFortnoxCapability: false,
};

describe('decision model', () => {
  it('weights sum to exactly 1', () => {
    expect(totalWeight()).toBe(1);
  });

  it('scores perfect signals as 1', () => {
    expect(computeDecisionScore(perfectSignals)).toBe(1);
  });

  it('allows automatic only when every gate is open and the score clears the bar', () => {
    const outcome = decide(perfectSignals, openGates);
    expect(outcome.level).toBe('automatic');
    expect(outcome.score).toBeGreaterThanOrEqual(DEFAULT_DECISION_THRESHOLDS.automatic);
  });

  it.each([
    ['deterministicRuleMatched', 'Ingen deterministisk regel matchade.'],
    ['validationsPassed', 'Alla bokföringsvalideringar passerade inte.'],
    ['requiredDocumentationPresent', 'Obligatoriskt underlag saknas.'],
    ['periodOpen', 'Perioden är inte öppen.'],
    ['withinAmountLimit', 'Beloppet överskrider gränsen för automatisk hantering.'],
    ['noConflictingFinding', 'Det finns en motstridig avvikelse.'],
  ] as const)('closing gate %s blocks automatic even with a perfect score', (gate, reason) => {
    const outcome = decide(perfectSignals, { ...openGates, [gate]: false });
    expect(outcome.level).not.toBe('automatic');
    expect(outcome.reasons).toContain(reason);
  });

  it.each([
    'periodLocked',
    'vatTreatmentUncertain',
    'requiresProfessionalJudgement',
    'materialAmount',
    'conflictingRules',
    'missingFortnoxCapability',
  ] as const)('gate %s forces manual assessment regardless of score', (gate) => {
    const outcome = decide(perfectSignals, { ...openGates, [gate]: true });
    expect(outcome.level).toBe('manual_assessment');
  });

  it('falls to manual assessment when the score is very low', () => {
    const poor: DecisionSignals = Object.fromEntries(
      Object.keys(perfectSignals).map((k) => [k, 0]),
    ) as DecisionSignals;
    const outcome = decide(poor, { ...openGates, deterministicRuleMatched: false });
    expect(outcome.level).toBe('manual_assessment');
  });

  it('lands on review between the two thresholds', () => {
    const outcome = decide(
      { ...perfectSignals, documentCompleteness: 0.4, historicalConsistency: 0.3 },
      { ...openGates, deterministicRuleMatched: false },
    );
    expect(outcome.level).toBe('review');
  });

  it('never uses a self-reported confidence field', () => {
    // The signal set is closed: adding an unknown key must not change the score.
    const withConfidence = { ...perfectSignals, modelConfidence: 0 } as unknown as DecisionSignals;
    expect(computeDecisionScore(withConfidence)).toBe(computeDecisionScore(perfectSignals));
  });

  it('maps amounts onto the materiality signal', () => {
    const threshold = sek(25000);
    expect(materialitySignal(sek(0), threshold)).toBe(1);
    expect(materialitySignal(sek(25000), threshold)).toBe(0);
    expect(materialitySignal(sek(12500), threshold)).toBeCloseTo(0.5, 5);
  });
});
