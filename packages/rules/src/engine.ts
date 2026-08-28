import { type FindingDraft, consolidateFindings } from '@trimeros/domain';
import {
  ALL_ANOMALY_RULES,
  ruleBalanceInsteadOfResult,
  ruleDeviatingVatCode,
  ruleManualVoucherUnusual,
  ruleMissingDimension,
  ruleMissingDocumentation,
  ruleMissingRecurringCost,
  rulePossibleDuplicate,
  ruleUnusualAccountForSupplier,
  ruleUnusualAmount,
  ruleWrongPeriod,
  type AnomalyInput,
} from './anomalies.js';
import type { RuleContext } from './context.js';
import type { EmitEnvironment } from './emit.js';
import { buildHistoryIndex, type HistoryIndex } from './history.js';
import { RULE_SET_VERSION } from './registry.js';
import {
  ALL_VALIDATIONS,
  validateAccounts,
  validateBalanced,
  validateDuplicateSourceRecords,
  validateFinancialYear,
  validateInputVatDocumentation,
  validatePeriodNotLocked,
  validateRequiredDimensions,
  validateVat,
  type ValidationInput,
} from './validations.js';

/**
 * Rule groups.
 *
 * The workflow runs the completeness group in the completeness step and the
 * ledger group in the general-ledger review step. Splitting them is not
 * cosmetic: it means two different steps can independently notice the same
 * underlying problem, and the consolidation step then has real work to do.
 */
export const COMPLETENESS_VALIDATIONS = [validateInputVatDocumentation] as const;
export const COMPLETENESS_ANOMALY_RULES = [
  ruleMissingDocumentation,
  ruleMissingRecurringCost,
  ruleWrongPeriod,
] as const;

export const LEDGER_VALIDATIONS = [
  validateBalanced,
  validateAccounts,
  validateFinancialYear,
  validatePeriodNotLocked,
  validateVat,
  validateRequiredDimensions,
  validateDuplicateSourceRecords,
] as const;
export const LEDGER_ANOMALY_RULES = [
  ruleUnusualAccountForSupplier,
  ruleDeviatingVatCode,
  ruleUnusualAmount,
  rulePossibleDuplicate,
  ruleMissingDimension,
  ruleManualVoucherUnusual,
  ruleBalanceInsteadOfResult,
] as const;

export interface RuleGroup {
  readonly name: string;
  readonly validations: readonly ((input: ValidationInput) => FindingDraft[])[];
  readonly anomalies: readonly ((input: AnomalyInput) => FindingDraft[])[];
}

export const COMPLETENESS_GROUP: RuleGroup = {
  name: 'completeness',
  validations: COMPLETENESS_VALIDATIONS,
  anomalies: COMPLETENESS_ANOMALY_RULES,
};

export const LEDGER_GROUP: RuleGroup = {
  name: 'general_ledger',
  validations: LEDGER_VALIDATIONS,
  anomalies: LEDGER_ANOMALY_RULES,
};

export const FULL_GROUP: RuleGroup = {
  name: 'full',
  validations: ALL_VALIDATIONS,
  anomalies: ALL_ANOMALY_RULES,
};

export interface RuleRunResult {
  /** Findings exactly as each rule produced them, before consolidation. */
  readonly raw: readonly FindingDraft[];
  /** Findings after deduplication by issue class + subject. */
  readonly consolidated: readonly FindingDraft[];
  readonly ruleSetVersion: string;
  readonly stats: RuleRunStats;
}

export interface RuleRunStats {
  readonly rawCount: number;
  readonly consolidatedCount: number;
  readonly mergedCount: number;
  readonly blockingCount: number;
  readonly byDecisionLevel: Readonly<Record<string, number>>;
}

export function buildEmitEnvironment(ctx: RuleContext): EmitEnvironment {
  return {
    clientId: ctx.clientId,
    period: ctx.period,
    policy: ctx.policy,
    periodLocked: isPeriodLocked(ctx),
  };
}

/** Runs one group of rules and returns the raw findings, without consolidating. */
export function runRuleGroup(
  ctx: RuleContext,
  group: RuleGroup,
  history?: HistoryIndex,
): FindingDraft[] {
  const env = buildEmitEnvironment(ctx);
  const index = history ?? buildHistoryIndex(ctx.historyVouchers);
  const out: FindingDraft[] = [];

  for (const validation of group.validations) out.push(...validation({ ctx, env }));
  for (const rule of group.anomalies) out.push(...rule({ ctx, env, history: index }));
  return out;
}

/** Consolidates findings from any number of rule runs into the final set. */
export function consolidate(drafts: readonly FindingDraft[]): RuleRunResult {
  const consolidated = consolidateFindings(drafts);

  const byDecisionLevel: Record<string, number> = {
    automatic: 0,
    review: 0,
    manual_assessment: 0,
  };
  for (const f of consolidated) {
    byDecisionLevel[f.decisionLevel] = (byDecisionLevel[f.decisionLevel] ?? 0) + 1;
  }

  return {
    raw: drafts,
    consolidated,
    ruleSetVersion: RULE_SET_VERSION,
    stats: {
      rawCount: drafts.length,
      consolidatedCount: consolidated.length,
      mergedCount: drafts.length - consolidated.length,
      blockingCount: consolidated.filter((f) => f.blocking).length,
      byDecisionLevel,
    },
  };
}

/** Convenience wrapper: run every rule and consolidate in one call. */
export function runRules(ctx: RuleContext): RuleRunResult {
  return consolidate(runRuleGroup(ctx, FULL_GROUP));
}

/** The analysed period is locked when its last day falls at or before the lock date. */
export function isPeriodLocked(ctx: RuleContext): boolean {
  if (!ctx.lockedThrough) return false;
  const [y, m] = ctx.period.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return lastDay <= ctx.lockedThrough;
}
