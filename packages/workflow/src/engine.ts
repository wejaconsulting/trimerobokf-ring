import { randomUUID } from 'node:crypto';
import type { ModelProvider } from '@trimeros/agent';
import type { Repositories } from '@trimeros/db';
import {
  DECISION_MODEL_VERSION,
  WORKFLOW_STEPS,
  assertStepTransition,
  assessCompletion,
  deriveRunStatus,
  isSettled,
  periodEnd,
  periodStart,
  type StepState,
  type StepStatus,
  type WorkflowStepKey,
} from '@trimeros/domain';
import type { FortnoxReadPort } from '@trimeros/fortnox';
import { RULE_SET_VERSION, type ProposalRule } from '@trimeros/rules';
import { createAuditWriter } from './audit.js';
import type { RunState, StepContext } from './run-context.js';
import { makeNotImplementedStep, stepCompletenessCheck, stepGeneralLedgerReview } from './steps/analysis.js';
import { stepConsolidateFindings } from './steps/consolidate.js';
import { stepAgentReadiness } from './steps/readiness.js';
import { stepAccountantReport, stepFinalControl, stepHumanReview } from './steps/report.js';
import type { CloseRunSummary, StartCloseRunInput, StepOutcome, WorkflowEngine } from './types.js';

type StepHandler = (ctx: StepContext) => Promise<StepOutcome>;

/**
 * The step table.
 *
 * Every one of the 14 steps has a handler. The ones phase 1 does not implement
 * get `makeNotImplementedStep`, which records the status *and* raises a
 * blocking finding when the step carries real accounting work.
 */
const HANDLERS: Readonly<Record<WorkflowStepKey, StepHandler>> = {
  agent_readiness: stepAgentReadiness,
  customer_and_supplier_invoices: makeNotImplementedStep('customer_and_supplier_invoices'),
  bank_and_tax_account_transactions: makeNotImplementedStep('bank_and_tax_account_transactions'),
  accruals_and_depreciations: makeNotImplementedStep('accruals_and_depreciations'),
  recurring_journal_entries: makeNotImplementedStep('recurring_journal_entries'),
  completeness_check: stepCompletenessCheck,
  general_ledger_review: stepGeneralLedgerReview,
  balance_reconciliations: makeNotImplementedStep('balance_reconciliations'),
  income_statement_analysis: makeNotImplementedStep('income_statement_analysis'),
  consolidate_findings: stepConsolidateFindings,
  accountant_report: stepAccountantReport,
  customer_communication_draft: makeNotImplementedStep('customer_communication_draft'),
  human_review: stepHumanReview,
  final_control: stepFinalControl,
};

export interface EngineDependencies {
  readonly repos: Repositories;
  readonly fortnox: FortnoxReadPort;
  readonly model: ModelProvider;
  readonly shadowMode: boolean;
}

/**
 * A database-backed workflow engine.
 *
 * State lives entirely in `close_run_steps`; execution is a single pass in
 * dependency order. This is the deliberate phase-1 choice over Temporal - see
 * docs/architecture.md - and the `WorkflowEngine` interface is what keeps the
 * eventual swap contained.
 */
export class DatabaseWorkflowEngine implements WorkflowEngine {
  readonly #deps: EngineDependencies;

  constructor(deps: EngineDependencies) {
    this.#deps = deps;
  }

  async startCloseRun(input: StartCloseRunInput): Promise<{ closeRunId: string }> {
    const { repos } = this.#deps;
    const scope = { tenantId: input.tenantId, clientId: input.clientId };

    const client = await repos.getClient(scope);
    if (!client) throw new Error(`Unknown client ${input.clientId} for tenant ${input.tenantId}`);

    const period = await repos.upsertPeriod(scope, {
      id: `period-${input.clientId}-${input.periodKey}`,
      tenantId: input.tenantId,
      clientId: input.clientId,
      periodKey: input.periodKey,
      startDate: periodStart(input.periodKey),
      endDate: periodEnd(input.periodKey),
      status: 'closing',
    });
    if (!period) throw new Error('Failed to create accounting period');

    const closeRunId = `run-${input.clientId}-${input.periodKey}-${Date.now().toString(36)}`;
    const correlationId = input.correlationId ?? randomUUID();

    const run = await repos.createCloseRun({
      id: closeRunId,
      tenantId: input.tenantId,
      clientId: input.clientId,
      periodId: period.id,
      periodKey: input.periodKey,
      status: 'pending',
      shadowMode: this.#deps.shadowMode,
      ruleSetVersion: RULE_SET_VERSION,
      decisionModelVersion: DECISION_MODEL_VERSION,
      correlationId,
    });

    await repos.insertSteps(
      WORKFLOW_STEPS.map((def) => ({
        id: `${closeRunId}-${def.key}`,
        tenantId: input.tenantId,
        closeRunId,
        stepKey: def.key,
        order: def.order,
        status: 'pending' satisfies StepStatus,
        attempt: 0,
        idempotencyKey: `${closeRunId}:${def.key}`,
      })),
    );

    const audit = createAuditWriter(repos, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      closeRunId,
      correlationId,
    });
    await audit({
      operation: 'close_run.created',
      actor: { kind: 'system', id: 'workflow-engine' },
      result: 'ok',
      ruleVersion: RULE_SET_VERSION,
      inputRefs: [`client:${input.clientId}`, `period:${input.periodKey}`, `shadow:${run.shadowMode}`],
    });

    return { closeRunId };
  }

  async executeCloseRun(tenantId: string, closeRunId: string): Promise<CloseRunSummary> {
    const { repos, fortnox, model, shadowMode } = this.#deps;
    const scope = { tenantId };

    const run = await repos.getCloseRun(scope, closeRunId);
    if (!run) throw new Error(`Unknown close run ${closeRunId}`);

    const clientScope = { tenantId, clientId: run.clientId };
    const client = await repos.getClient(clientScope);
    const policy = await repos.getPolicy(clientScope);
    if (!client) throw new Error(`Unknown client ${run.clientId}`);
    if (!policy) throw new Error(`Client ${run.clientId} has no accounting policy`);

    const clientRules = await repos.listClientRules(clientScope);
    const proposalRules = toProposalRules(clientRules);

    const audit = createAuditWriter(repos, {
      tenantId,
      clientId: run.clientId,
      closeRunId,
      correlationId: run.correlationId,
    });

    const state: RunState = { rawFindings: [] };
    const ctx: StepContext = {
      tenantId,
      clientId: run.clientId,
      closeRunId,
      periodKey: run.periodKey,
      correlationId: run.correlationId,
      client,
      policy,
      proposalRules,
      fortnox,
      model,
      repos,
      audit,
      state,
      shadowMode,
    };

    await repos.updateCloseRun(scope, closeRunId, { status: 'running', startedAt: new Date() });

    // Steps are declared in dependency order, so a single ordered pass is
    // enough. `isRunnable` still guards it, so a future reordering cannot
    // silently run a step before its inputs exist.
    for (const def of WORKFLOW_STEPS) {
      const existing = await repos.listSteps(scope, closeRunId);
      const current = existing.find((s) => s.stepKey === def.key);
      if (!current) continue;
      if (current.status === 'completed') continue;

      const states: StepState[] = existing.map((s) => ({
        stepKey: s.stepKey as WorkflowStepKey,
        status: s.status as StepStatus,
      }));
      const dependenciesSettled = def.dependsOn.every((dep) =>
        isSettled(states.find((s) => s.stepKey === dep)?.status),
      );

      if (!dependenciesSettled) {
        await this.#transition(ctx, def.key, current.status as StepStatus, {
          status: 'blocked',
          reasonCode: 'dependency_not_settled',
          message: `Beroende steg är inte klara: ${def.dependsOn.join(', ')}.`,
        });
        continue;
      }

      await this.#transition(ctx, def.key, current.status as StepStatus, { status: 'running' }, true);

      try {
        const outcome = await HANDLERS[def.key](ctx);
        await this.#transition(ctx, def.key, 'running', outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#transition(ctx, def.key, 'running', {
          status: 'failed',
          reasonCode: 'step_threw',
          message,
        });
        await audit({
          operation: 'close_run.step_failed',
          actor: { kind: 'system', id: 'workflow-engine' },
          result: 'error',
          inputRefs: [`step:${def.key}`],
          errorCode: 'step_threw',
          errorMessage: message,
        });
      }
    }

    const summary = await this.getSummary(tenantId, closeRunId);
    await repos.updateCloseRun(scope, closeRunId, {
      status: summary.status,
      finishedAt: new Date(),
    });
    await audit({
      operation: summary.canComplete ? 'close_run.completed' : 'close_run.step_blocked',
      actor: { kind: 'system', id: 'workflow-engine' },
      result: summary.canComplete ? 'ok' : 'blocked',
      inputRefs: [`status:${summary.status}`, `blocking_findings:${summary.blockingFindingCount}`],
    });

    return { ...summary, status: summary.status };
  }

  async getSummary(tenantId: string, closeRunId: string): Promise<CloseRunSummary> {
    const { repos } = this.#deps;
    const scope = { tenantId };

    const steps = await repos.listSteps(scope, closeRunId);
    const findings = await repos.listFindings(scope, { closeRunId });
    const openBlocking = findings.filter(
      (f) => f.blocking && ['open', 'in_review', 'information_requested'].includes(f.status),
    );

    const states: StepState[] = steps.map((s) => ({
      stepKey: s.stepKey as WorkflowStepKey,
      status: s.status as StepStatus,
    }));
    const assessment = assessCompletion(states, openBlocking.length);

    // "Clear" means: a voucher in the period that no rule reacted to at all.
    // Counting vouchers rather than every imported record keeps the number
    // comparable to what the consultant sees in the ledger.
    const run = await repos.getCloseRun(scope, closeRunId);
    const touchedVouchers = new Set(
      findings
        .map((f) => (f.subject as { voucherId?: string }).voucherId)
        .filter((v): v is string => Boolean(v)),
    );
    const voucherCount = run
      ? await repos.countImportedRecordsByKind(
          { tenantId, clientId: run.clientId },
          run.periodKey,
          'voucher',
        )
      : 0;
    const clearItemCount = Math.max(0, voucherCount - touchedVouchers.size);

    return {
      closeRunId,
      status: deriveRunStatus(states, openBlocking.length),
      steps: states.map((s) => ({
        stepKey: s.stepKey,
        status: s.status,
        message: steps.find((row) => row.stepKey === s.stepKey)?.message ?? null,
      })),
      findingCount: findings.length,
      blockingFindingCount: openBlocking.length,
      reviewCount: findings.filter((f) => f.decisionLevel === 'review').length,
      manualCount: findings.filter((f) => f.decisionLevel === 'manual_assessment').length,
      clearItemCount,
      canComplete: assessment.canComplete,
      reasons: assessment.reasons,
    };
  }

  async #transition(
    ctx: StepContext,
    stepKey: WorkflowStepKey,
    from: StepStatus,
    outcome: StepOutcome,
    starting = false,
  ): Promise<void> {
    assertStepTransition(from, outcome.status);

    await ctx.repos.updateStep({ tenantId: ctx.tenantId }, ctx.closeRunId, stepKey, {
      status: outcome.status,
      reasonCode: outcome.reasonCode ?? null,
      message: outcome.message ?? null,
      ...(starting ? { startedAt: new Date() } : { finishedAt: new Date() }),
    });

    if (starting) {
      await ctx.audit({
        operation: 'close_run.step_started',
        actor: { kind: 'system', id: 'workflow-engine' },
        result: 'ok',
        inputRefs: [`step:${stepKey}`],
      });
      return;
    }

    await ctx.audit({
      operation:
        outcome.status === 'completed'
          ? 'close_run.step_completed'
          : outcome.status === 'failed'
            ? 'close_run.step_failed'
            : 'close_run.step_blocked',
      actor: { kind: 'system', id: 'workflow-engine' },
      result: outcome.status === 'completed' ? 'ok' : outcome.status === 'failed' ? 'error' : 'blocked',
      inputRefs: [`step:${stepKey}`, `status:${outcome.status}`],
      errorCode: outcome.reasonCode ?? null,
    });
  }
}

/** Maps persisted client rules onto the typed rules the proposal generator uses. */
export function toProposalRules(
  rows: readonly { kind: string; config: Record<string, unknown> }[],
): ProposalRule[] {
  const out: ProposalRule[] = [];
  for (const row of rows) {
    if (row.kind === 'dimension_requirement') {
      const account = Number(row.config.account);
      const costCenter = String(row.config.costCenter ?? '');
      if (Number.isFinite(account) && costCenter) {
        out.push({ kind: 'dimension_requirement', account, costCenter });
      }
    }
    if (row.kind === 'recurring_cost') {
      const account = Number(row.config.account);
      const accrualAccount = Number(row.config.accrualAccount);
      const supplierNumber = String(row.config.supplierNumber ?? '');
      if (Number.isFinite(account) && Number.isFinite(accrualAccount) && supplierNumber) {
        out.push({ kind: 'recurring_cost', supplierNumber, account, accrualAccount });
      }
    }
  }
  return out;
}
