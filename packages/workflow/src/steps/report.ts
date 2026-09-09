import {
  ACCOUNTANT_REPORT_PROMPT,
  ALLOWED_TOOLS,
  accountantReportJsonSchema,
  accountantReportSchema,
} from '@trimeros/agent';
import { WORKFLOW_STEPS, assessCompletion, formatSek, type StepState } from '@trimeros/domain';
import type { StepContext } from '../run-context.js';
import { submitApprovedProposals } from '../submit.js';
import type { StepOutcome } from '../types.js';

/**
 * Step 11 - Accountant report.
 *
 * The one place a language model is used. It receives an already-consolidated,
 * already-decided summary and is asked to phrase it; it cannot change a number,
 * a decision level or a status. Its input contains no document text, no
 * personal data and no credentials - only counts, amounts and rule rationales.
 */
export async function stepAccountantReport(ctx: StepContext): Promise<StepOutcome> {
  const findings = ctx.state.consolidatedFindings ?? [];
  const notImplemented = WORKFLOW_STEPS.filter((s) => !s.implemented && s.blocksCompletion);

  const input = {
    clientName: ctx.client.name,
    period: ctx.periodKey,
    totalFindings: findings.length,
    blockingFindings: findings.filter((f) => f.blocking).length,
    reviewFindings: findings.filter((f) => f.decisionLevel === 'review').length,
    manualFindings: findings.filter((f) => f.decisionLevel === 'manual_assessment').length,
    clearItems: ctx.state.clearItemCount ?? 0,
    notImplementedSteps: notImplemented.map((s) => ({ labelSv: s.labelSv })),
    topFindings: findings.slice(0, 5).map((f) => ({
      description: f.description,
      severity: f.severity,
      rationale: f.rationale,
      amount: formatSek(f.amount),
    })),
    blockers: findings.filter((f) => f.blocking).map((f) => f.description),
  };

  const result = await ctx.model.generateStructured({
    prompt: ACCOUNTANT_REPORT_PROMPT,
    input,
    schema: accountantReportSchema,
    jsonSchema: accountantReportJsonSchema,
    tools: ALLOWED_TOOLS,
    correlationId: ctx.correlationId,
  });

  ctx.state.report = {
    headline: result.data.headline,
    summary: result.data.summary,
    blockers: result.data.blockers,
  };

  await ctx.audit({
    operation: 'agent.model_invoked',
    actor: { kind: 'model', id: result.provider },
    result: 'ok',
    promptVersion: result.promptVersion,
    modelProvider: result.provider,
    modelName: result.model,
    inputRefs: [
      `tokens_in:${result.usage.inputTokens}`,
      `tokens_out:${result.usage.outputTokens}`,
      `cost_usd:${result.usage.estimatedCostUsd.toFixed(6)}`,
      `latency_ms:${result.latencyMs}`,
      `attempts:${result.attempts}`,
    ],
    // Tool calls are recorded but never executed in phase 1.
    toolCall: result.requestedToolCalls.map((c) => c.name).join(',') || null,
  });

  return { status: 'completed', message: result.data.headline };
}

/**
 * Step 13 - Human review.
 *
 * Completes only once no finding requiring a consultant is still open. It is
 * therefore the step that stays `blocked` while the queue has work in it, which
 * is exactly the signal the consultant's dashboard needs.
 */
export async function stepHumanReview(ctx: StepContext): Promise<StepOutcome> {
  // Live booking, when - and only when - the operator switched it on. Every
  // proposal still has to pass the seven-condition gate individually; the
  // step only reports what happened.
  let booked = '';
  if (ctx.fortnoxWritesEnabled && !ctx.shadowMode) {
    const result = await submitApprovedProposals(ctx.repos, {
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      closeRunId: ctx.closeRunId,
      correlationId: ctx.correlationId,
      dataSource: ctx.dataSource,
      shadowMode: ctx.shadowMode,
      featureFlagEnabled: ctx.fortnoxWritesEnabled,
    });
    if (result.submitted.length + result.blocked.length + result.failed.length > 0) {
      booked =
        ` ${result.submitted.length} förslag bokförda i Fortnox` +
        (result.blocked.length > 0 ? `, ${result.blocked.length} stoppade av skrivgrinden` : '') +
        (result.failed.length > 0 ? `, ${result.failed.length} misslyckade` : '') +
        '.';
    }
  }

  const open = await ctx.repos.listFindings(
    { tenantId: ctx.tenantId },
    { closeRunId: ctx.closeRunId, status: ['open', 'in_review', 'information_requested'] },
  );
  const needingConsultant = open.filter((f) => f.requiresConsultant);

  if (needingConsultant.length === 0) {
    return { status: 'completed', message: `Inga öppna avvikelser kräver konsult.${booked}` };
  }

  return {
    status: 'blocked',
    reasonCode: 'awaiting_human_review',
    message: `${needingConsultant.length} avvikelse(r) väntar på konsultens beslut.${booked}`,
  };
}

/**
 * Step 14 - Final control.
 *
 * The gate that decides whether the period may be called complete. It refuses
 * on either of two grounds: a blocking finding is still open, or a step that
 * carries real accounting work has not completed - including a step this phase
 * has not implemented.
 */
export async function stepFinalControl(ctx: StepContext): Promise<StepOutcome> {
  const steps = await ctx.repos.listSteps({ tenantId: ctx.tenantId }, ctx.closeRunId);
  const blocking = await ctx.repos.listFindings(
    { tenantId: ctx.tenantId },
    { closeRunId: ctx.closeRunId, blocking: true, status: ['open', 'in_review', 'information_requested'] },
  );

  const states: StepState[] = steps
    .filter((s) => s.stepKey !== 'final_control')
    .map((s) => ({
      stepKey: s.stepKey as StepState['stepKey'],
      status: s.status as StepState['status'],
    }));

  const assessment = assessCompletion(states, blocking.length);

  if (assessment.canComplete) {
    return { status: 'completed', message: 'Perioden kan rapporteras som komplett.' };
  }

  return {
    status: 'blocked',
    reasonCode: 'completion_blocked',
    message: assessment.reasons.join(' '),
  };
}
