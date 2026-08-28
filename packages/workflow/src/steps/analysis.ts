import { getStepDefinition, type FindingDraft, type WorkflowStepKey } from '@trimeros/domain';
import {
  COMPLETENESS_GROUP,
  LEDGER_GROUP,
  RULE_SET_VERSION,
  buildEmitEnvironment,
  buildHistoryIndex,
  collectSourceKeys,
  notImplementedFinding,
  runRuleGroup,
  type RuleContext,
} from '@trimeros/rules';
import type { StepContext } from '../run-context.js';
import type { StepOutcome } from '../types.js';

/** Returned when the readiness step never produced a ledger to analyse. */
const LEDGER_MISSING: StepOutcome = {
  status: 'blocked',
  reasonCode: 'ledger_not_loaded',
  message: 'Steget kunde inte köras eftersom agentberedskapen blockerades och ingen huvudbok laddades.',
};

/** Builds the rule context once, from the state the readiness step loaded. */
export class LedgerNotLoadedError extends Error {
  override readonly name = 'LedgerNotLoadedError';
}

export function ensureRuleContext(ctx: StepContext): RuleContext {
  if (ctx.state.ruleContext) return ctx.state.ruleContext;
  const ledger = ctx.state.ledger;
  if (!ledger) {
    throw new LedgerNotLoadedError(
      'Huvudboken laddades aldrig - agentberedskapssteget blockerades.',
    );
  }

  const ruleContext: RuleContext = {
    clientId: ctx.clientId,
    period: ctx.periodKey,
    policy: {
      materialityThreshold: ctx.policy.materialityThreshold,
      automationAmountLimit: ctx.policy.automationAmountLimit,
      costCenterRequiredAccounts: ctx.policy.costCenterRequiredAccounts,
      projectRequiredAccounts: ctx.policy.projectRequiredAccounts,
      requireDocumentationForInputVat: ctx.policy.requireDocumentationForInputVat,
      historyWindowMonths: ctx.policy.historyWindowMonths,
      amountDeviationThreshold: ctx.policy.amountDeviationThreshold,
      vatRates: ctx.policy.vatRates,
    },
    current: ledger.current,
    historyVouchers: ledger.historyVouchers,
    allSupplierInvoices: ledger.allSupplierInvoices,
    financialYears: ledger.current.financialYears,
    lockedThrough: ledger.lockedThrough,
    unavailableCapabilities: ctx.state.capabilities?.unavailable ?? [],
    alreadyProcessedSourceKeys: new Set<string>(),
  };
  ctx.state.ruleContext = ruleContext;
  return ruleContext;
}

/**
 * Step 6 - Completeness check.
 *
 * Asks "is anything missing?": absent recurring costs, postings with no
 * documentation, and invoices booked into the wrong month.
 */
export async function stepCompletenessCheck(ctx: StepContext): Promise<StepOutcome> {
  if (!ctx.state.ledger) return LEDGER_MISSING;
  const ruleContext = ensureRuleContext(ctx);
  const history = buildHistoryIndex(ruleContext.historyVouchers);
  const findings = runRuleGroup(ruleContext, COMPLETENESS_GROUP, history);
  ctx.state.rawFindings.push(...findings);

  await ctx.audit({
    operation: 'rules.evaluated',
    actor: { kind: 'system', id: 'rules-engine' },
    result: 'ok',
    ruleVersion: RULE_SET_VERSION,
    inputRefs: [`group:${COMPLETENESS_GROUP.name}`, `period:${ctx.periodKey}`],
  });

  return {
    status: 'completed',
    message: `${findings.length} observation(er) från fullständighetskontrollen.`,
  };
}

/**
 * Step 7 - General-ledger review.
 *
 * Runs the mandatory validations and the ledger anomaly rules over every
 * voucher row in the period.
 */
export async function stepGeneralLedgerReview(ctx: StepContext): Promise<StepOutcome> {
  if (!ctx.state.ledger) return LEDGER_MISSING;
  const ruleContext = ensureRuleContext(ctx);

  // Source keys already booked by an earlier completed run make a re-run
  // idempotent rather than duplicate-producing.
  const processed = await ctx.repos.listProcessedSourceKeys({
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
  });
  const contextWithHistory: RuleContext = {
    ...ruleContext,
    alreadyProcessedSourceKeys: new Set(processed),
  };
  ctx.state.ruleContext = contextWithHistory;

  const history = buildHistoryIndex(contextWithHistory.historyVouchers);
  const findings = runRuleGroup(contextWithHistory, LEDGER_GROUP, history);
  ctx.state.rawFindings.push(...findings);

  await ctx.audit({
    operation: 'rules.evaluated',
    actor: { kind: 'system', id: 'rules-engine' },
    result: 'ok',
    ruleVersion: RULE_SET_VERSION,
    inputRefs: [`group:${LEDGER_GROUP.name}`, `period:${ctx.periodKey}`],
  });

  await ctx.repos.recordProcessedSourceKeys(
    { tenantId: ctx.tenantId, clientId: ctx.clientId },
    ctx.closeRunId,
    collectSourceKeys(contextWithHistory),
  );

  return {
    status: 'completed',
    message: `${findings.length} observation(er) från huvudboksgranskningen.`,
  };
}

/**
 * Marks a step that phase 1 does not implement.
 *
 * A step carrying real accounting work also emits a blocking finding, so the
 * gap is visible in the review queue rather than only in a status column. That
 * is what stops the system from reporting a period as complete simply because
 * it never looked.
 */
export function makeNotImplementedStep(stepKey: WorkflowStepKey) {
  return async function stepNotImplemented(ctx: StepContext): Promise<StepOutcome> {
    const def = getStepDefinition(stepKey);

    if (def.blocksCompletion && ctx.state.ledger) {
      const env = buildEmitEnvironment(ensureRuleContext(ctx));
      const finding: FindingDraft = notImplementedFinding(env, {
        key: def.key,
        labelSv: def.labelSv,
        description: def.description,
      });
      ctx.state.rawFindings.push(finding);
    }

    return {
      status: 'not_implemented',
      reasonCode: 'phase_1_scope',
      message: def.description,
    };
  };
}
