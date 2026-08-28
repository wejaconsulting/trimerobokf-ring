import { z } from 'zod';
import type { DecisionLevel } from './enums.js';
import { type Ore, absOre } from './money.js';

/**
 * The decision model.
 *
 * A language model's self-reported confidence is deliberately NOT an input
 * here. The level is derived from (a) hard gates that can veto automation
 * outright and (b) a weighted score over observable, explainable signals.
 *
 * See docs/accounting-decision-model.md for the reasoning behind each weight.
 */

export const DECISION_MODEL_VERSION = 'decision-model@1.0.0';

/** Every signal is normalised to [0, 1] where 1 = "supports automation". */
export const decisionSignalsSchema = z.object({
  /** Is the statutory documentation (receipt/invoice) present and readable? */
  documentCompleteness: z.number().min(0).max(1),
  /** Did a deterministic client rule or account mapping match exactly? */
  deterministicRuleMatch: z.number().min(0).max(1),
  /** Does this look like what this client/supplier has done historically? */
  historicalConsistency: z.number().min(0).max(1),
  /** Confidence that the counterparty was identified (org.nr, exact name, known supplier). */
  counterpartyIdentityMatch: z.number().min(0).max(1),
  /** Is the amount in line with the same recurring posting? */
  amountConsistency: z.number().min(0).max(1),
  /** Does the VAT code / VAT amount agree with the account and the document? */
  vatConsistency: z.number().min(0).max(1),
  /** Are required cost center / project dimensions present and plausible? */
  dimensionConsistency: z.number().min(0).max(1),
  /** 1 = certainly not a duplicate, 0 = almost certainly a duplicate. */
  duplicateRisk: z.number().min(0).max(1),
  /** 1 = no impact on an open reconciliation, 0 = breaks a reconciliation. */
  reconciliationImpact: z.number().min(0).max(1),
  /** 1 = immaterial amount, 0 = at or above the materiality threshold. */
  materiality: z.number().min(0).max(1),
});
export type DecisionSignals = z.infer<typeof decisionSignalsSchema>;

export const DECISION_WEIGHTS: Readonly<Record<keyof DecisionSignals, number>> = {
  documentCompleteness: 0.18,
  deterministicRuleMatch: 0.2,
  historicalConsistency: 0.12,
  counterpartyIdentityMatch: 0.08,
  amountConsistency: 0.1,
  vatConsistency: 0.12,
  dimensionConsistency: 0.05,
  duplicateRisk: 0.08,
  reconciliationImpact: 0.04,
  materiality: 0.03,
};

/**
 * Hard gates. Each one, when true, forces the decision away from `automatic`.
 * `manualOnly` gates force `manual_assessment` regardless of score.
 */
export const decisionGatesSchema = z.object({
  /** A deterministic rule produced the proposal (required for automatic). */
  deterministicRuleMatched: z.boolean(),
  /** All mandatory bookkeeping validations passed (required for automatic). */
  validationsPassed: z.boolean(),
  /** Statutory documentation present (required for automatic). */
  requiredDocumentationPresent: z.boolean(),
  /** The accounting period is open (required for automatic). */
  periodOpen: z.boolean(),
  /** Amount is within the client's automation limit (required for automatic). */
  withinAmountLimit: z.boolean(),
  /** No other finding contradicts this proposal (required for automatic). */
  noConflictingFinding: z.boolean(),

  // --- manual-only gates -------------------------------------------------
  /** VAT treatment could not be established with certainty. */
  vatTreatmentUncertain: z.boolean(),
  /** A tax or accounting judgement is required. */
  requiresProfessionalJudgement: z.boolean(),
  /** The period is locked in Fortnox. */
  periodLocked: z.boolean(),
  /** The amount is material for this client. */
  materialAmount: z.boolean(),
  /** Two or more rules or data sources contradict each other. */
  conflictingRules: z.boolean(),
  /** A Fortnox capability this action needs is not available via the public API. */
  missingFortnoxCapability: z.boolean(),
});
export type DecisionGates = z.infer<typeof decisionGatesSchema>;

export interface DecisionThresholds {
  /** Minimum score required for `automatic`. */
  readonly automatic: number;
  /** Minimum score required for `review`; below this it is manual assessment. */
  readonly review: number;
}

export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = {
  automatic: 0.85,
  review: 0.45,
};

export interface DecisionOutcome {
  readonly level: DecisionLevel;
  /** Weighted score in [0, 1], rounded to 4 decimals. */
  readonly score: number;
  /** Human-readable, ordered explanation of why this level was chosen. */
  readonly reasons: readonly string[];
  /** Per-signal contribution, for the "why" panel in the review UI. */
  readonly contributions: Readonly<Record<keyof DecisionSignals, number>>;
  readonly modelVersion: string;
}

const MANUAL_GATES: readonly (readonly [keyof DecisionGates, string])[] = [
  ['periodLocked', 'Perioden är låst i Fortnox.'],
  ['vatTreatmentUncertain', 'Momsbehandlingen är osäker.'],
  ['requiresProfessionalJudgement', 'Skatte- eller redovisningsmässig bedömning krävs.'],
  ['materialAmount', 'Beloppet är väsentligt för klienten.'],
  ['conflictingRules', 'Motstridiga regler eller uppgifter.'],
  ['missingFortnoxCapability', 'Nödvändig Fortnox-capability saknas i publikt API.'],
];

const AUTOMATIC_GATES: readonly (readonly [keyof DecisionGates, string])[] = [
  ['deterministicRuleMatched', 'Ingen deterministisk regel matchade.'],
  ['validationsPassed', 'Alla bokföringsvalideringar passerade inte.'],
  ['requiredDocumentationPresent', 'Obligatoriskt underlag saknas.'],
  ['periodOpen', 'Perioden är inte öppen.'],
  ['withinAmountLimit', 'Beloppet överskrider gränsen för automatisk hantering.'],
  ['noConflictingFinding', 'Det finns en motstridig avvikelse.'],
];

export function computeDecisionScore(signals: DecisionSignals): number {
  let total = 0;
  for (const [key, weight] of Object.entries(DECISION_WEIGHTS) as [keyof DecisionSignals, number][]) {
    total += signals[key] * weight;
  }
  return round4(total);
}

export function decide(
  signals: DecisionSignals,
  gates: DecisionGates,
  thresholds: DecisionThresholds = DEFAULT_DECISION_THRESHOLDS,
): DecisionOutcome {
  const score = computeDecisionScore(signals);
  const contributions = Object.fromEntries(
    (Object.keys(DECISION_WEIGHTS) as (keyof DecisionSignals)[]).map((k) => [
      k,
      round4(signals[k] * DECISION_WEIGHTS[k]),
    ]),
  ) as Record<keyof DecisionSignals, number>;

  const reasons: string[] = [];

  const manualHits = MANUAL_GATES.filter(([g]) => gates[g]).map(([, msg]) => msg);
  if (manualHits.length > 0) {
    reasons.push(...manualHits);
    return {
      level: 'manual_assessment',
      score,
      reasons,
      contributions,
      modelVersion: DECISION_MODEL_VERSION,
    };
  }

  const automaticBlockers = AUTOMATIC_GATES.filter(([g]) => !gates[g]).map(([, msg]) => msg);

  if (automaticBlockers.length === 0 && score >= thresholds.automatic) {
    reasons.push(
      `Alla automatiseringsgrindar passerade och decision score ${score.toFixed(2)} >= ${thresholds.automatic}.`,
    );
    return { level: 'automatic', score, reasons, contributions, modelVersion: DECISION_MODEL_VERSION };
  }

  reasons.push(...automaticBlockers);
  if (automaticBlockers.length === 0) {
    reasons.push(
      `Decision score ${score.toFixed(2)} understiger gränsen ${thresholds.automatic} för automatisk hantering.`,
    );
  }

  if (score < thresholds.review) {
    reasons.push(
      `Decision score ${score.toFixed(2)} understiger gränsen ${thresholds.review} för review.`,
    );
    return {
      level: 'manual_assessment',
      score,
      reasons,
      contributions,
      modelVersion: DECISION_MODEL_VERSION,
    };
  }

  return { level: 'review', score, reasons, contributions, modelVersion: DECISION_MODEL_VERSION };
}

/** Materiality: an amount is material when it exceeds the client's threshold. */
export function isMaterial(amount: Ore, materialityThreshold: Ore): boolean {
  return absOre(amount) >= materialityThreshold;
}

/** Maps an amount to the [0,1] materiality signal (1 = immaterial). */
export function materialitySignal(amount: Ore, materialityThreshold: Ore): number {
  if (materialityThreshold <= 0) return 0;
  const ratio = absOre(amount) / materialityThreshold;
  return clamp01(1 - ratio);
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Sanity check kept next to the weights so drift is caught by a unit test. */
export function totalWeight(): number {
  return round4(Object.values(DECISION_WEIGHTS).reduce((a, b) => a + b, 0));
}
