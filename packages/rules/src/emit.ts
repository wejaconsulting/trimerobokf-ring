import {
  type DecisionGates,
  type DecisionSignals,
  type EvidenceRef,
  type FindingDraft,
  type FindingSubject,
  type FindingType,
  type Ore,
  type PeriodKey,
  type Severity,
  buildDeduplicationKey,
  decide,
  isBlockingType,
  isMaterial,
  materialitySignal,
} from '@trimeros/domain';
import type { RulePolicy } from './context.js';
import type { RuleMeta } from './registry.js';

/** Neutral starting point: everything looks fine until a rule says otherwise. */
export const NEUTRAL_SIGNALS: DecisionSignals = {
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

export const NEUTRAL_GATES: DecisionGates = {
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

export interface EmitInput {
  readonly rule: RuleMeta;
  readonly type: FindingType;
  readonly severity: Severity;
  readonly subject: FindingSubject;
  readonly amount: Ore;
  readonly description: string;
  readonly rationale: string;
  readonly suggestedAction: string;
  readonly evidence: readonly EvidenceRef[];
  /**
   * The class of issue, NOT the rule id. Two rules that notice the same problem
   * must pass the same `issueClass` so consolidation collapses them.
   */
  readonly issueClass: string;
  readonly signals: Partial<DecisionSignals>;
  readonly gates: Partial<DecisionGates>;
}

export interface EmitEnvironment {
  readonly clientId: string;
  readonly period: PeriodKey;
  readonly policy: RulePolicy;
  readonly periodLocked: boolean;
}

/**
 * Turns a rule observation into a finding.
 *
 * Materiality and the amount limit are applied here rather than in each rule,
 * so a rule author cannot accidentally let a 500 000 kr item through as
 * "automatic" by forgetting a check.
 */
export function emitFinding(env: EmitEnvironment, input: EmitInput): FindingDraft {
  const material = isMaterial(input.amount, env.policy.materialityThreshold);

  const signals: DecisionSignals = {
    ...NEUTRAL_SIGNALS,
    ...input.signals,
    materiality: input.signals.materiality ?? materialitySignal(input.amount, env.policy.materialityThreshold),
  };

  const gates: DecisionGates = {
    ...NEUTRAL_GATES,
    ...input.gates,
    periodOpen: !env.periodLocked && (input.gates.periodOpen ?? true),
    periodLocked: env.periodLocked || (input.gates.periodLocked ?? false),
    materialAmount: material || (input.gates.materialAmount ?? false),
    withinAmountLimit:
      Math.abs(input.amount) <= env.policy.automationAmountLimit &&
      (input.gates.withinAmountLimit ?? true),
  };

  const outcome = decide(signals, gates);
  const blocking = isBlockingType(input.type);

  return {
    type: input.type,
    severity: input.severity,
    subject: input.subject,
    amount: input.amount,
    description: input.description,
    rationale: input.rationale,
    suggestedAction: input.suggestedAction,
    evidence: [...input.evidence],
    decisionLevel: outcome.level,
    decisionScore: outcome.score,
    decisionReasons: [...outcome.reasons],
    requiresConsultant: outcome.level !== 'automatic',
    blocking,
    deduplicationKey: buildDeduplicationKey({
      clientId: env.clientId,
      periodKey: env.period,
      issueClass: input.issueClass,
      subject: input.subject,
    }),
    ruleId: input.rule.id,
    ruleVersion: input.rule.version,
  };
}
