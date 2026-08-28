import { randomUUID } from 'node:crypto';
import { simulateVoucherCreate } from '@trimeros/fortnox';
import { consolidate, generateProposals, proposalBalances } from '@trimeros/rules';
import type { StepContext } from '../run-context.js';
import type { StepOutcome } from '../types.js';
import { ensureRuleContext } from './analysis.js';

/**
 * Step 10 - Consolidate findings.
 *
 * Deduplicates everything the earlier steps produced, persists the result, and
 * builds the booking proposals. In shadow mode a proposal is turned into a
 * *simulated* Fortnox request: the exact payload, the exact endpoint and a hash
 * that will later bind a human approval to those exact bytes. Nothing is sent.
 */
export async function stepConsolidateFindings(ctx: StepContext): Promise<StepOutcome> {
  if (!ctx.state.ledger) {
    return {
      status: 'blocked',
      reasonCode: 'ledger_not_loaded',
      message: 'Ingen huvudbok laddades, så det finns inget att konsolidera.',
    };
  }
  const ruleContext = ensureRuleContext(ctx);
  const result = consolidate(ctx.state.rawFindings);
  ctx.state.consolidatedFindings = result.consolidated;

  const scope = { tenantId: ctx.tenantId };

  const persisted = await ctx.repos.upsertFindings(
    result.consolidated.map((f) => ({
      id: `finding-${ctx.closeRunId}-${hashKey(f.deduplicationKey)}`,
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      closeRunId: ctx.closeRunId,
      type: f.type,
      severity: f.severity,
      subject: f.subject as Record<string, unknown>,
      amount: f.amount,
      description: f.description,
      rationale: f.rationale,
      suggestedAction: f.suggestedAction,
      evidence: [...f.evidence],
      decisionLevel: f.decisionLevel,
      decisionScore: f.decisionScore,
      decisionReasons: [...f.decisionReasons],
      requiresConsultant: f.requiresConsultant,
      blocking: f.blocking,
      deduplicationKey: f.deduplicationKey,
      ruleId: f.ruleId,
      ruleVersion: f.ruleVersion,
      mergedFromRuleIds: mergedRuleIds(f),
      occurrences: occurrencesOf(f),
      status: 'open',
    })),
  );

  await ctx.audit({
    operation: 'finding.consolidated',
    actor: { kind: 'system', id: 'rules-engine' },
    result: 'ok',
    ruleVersion: result.ruleSetVersion,
    inputRefs: [
      `raw:${result.stats.rawCount}`,
      `consolidated:${result.stats.consolidatedCount}`,
      `merged:${result.stats.mergedCount}`,
    ],
  });

  // --- booking proposals --------------------------------------------------
  await ctx.repos.deleteProposalsForRun(scope, ctx.closeRunId);

  const proposals = generateProposals(ruleContext, result.consolidated, ctx.proposalRules);
  ctx.state.proposals = proposals;

  const findingIdByKey = new Map(persisted.map((f) => [f.deduplicationKey, f.id]));
  let simulated = 0;

  for (const proposal of proposals) {
    if (!proposalBalances(proposal)) {
      // A proposal that does not balance is a bug in the generator, never
      // something to show a consultant as if it were a suggestion.
      await ctx.audit({
        operation: 'proposal.created',
        actor: { kind: 'system', id: 'rules-engine' },
        result: 'error',
        errorCode: 'proposal_unbalanced',
        errorMessage: `Proposal for ${proposal.findingDeduplicationKey} does not balance.`,
      });
      continue;
    }

    const request = simulateVoucherCreate({
      description: proposal.description,
      transactionDate: proposal.transactionDate,
      series: proposal.series,
      rows: proposal.rows.map((r) => ({
        account: r.account,
        debit: r.debit,
        credit: r.credit,
        description: r.description,
        costCenter: r.costCenter,
        project: r.project,
      })),
    });

    const proposalId = `proposal-${ctx.closeRunId}-${hashKey(proposal.findingDeduplicationKey)}`;
    await ctx.repos.insertProposal(
      {
        id: proposalId,
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        closeRunId: ctx.closeRunId,
        findingId: findingIdByKey.get(proposal.findingDeduplicationKey) ?? null,
        // "simulated" is the only status a proposal can reach in shadow mode.
        status: 'simulated',
        decisionLevel: proposal.decision.level,
        decisionScore: proposal.decision.score,
        decisionReasons: [...proposal.decision.reasons],
        transactionDate: proposal.transactionDate,
        series: proposal.series,
        description: proposal.description,
        rationale: proposal.rationale,
        simulatedFortnoxPayload: request.payload,
        simulatedFortnoxEndpoint: `${request.method} ${request.endpoint}`,
        simulatedPayloadHash: request.payloadHash,
      },
      proposal.rows.map((r) => ({
        id: randomUUID(),
        tenantId: ctx.tenantId,
        account: r.account,
        debit: r.debit,
        credit: r.credit,
        description: r.description,
        costCenter: r.costCenter,
        project: r.project,
        vatCode: r.vatCode,
      })),
    );
    simulated += 1;

    await ctx.audit({
      operation: 'fortnox.write_simulated',
      actor: { kind: 'system', id: 'workflow-engine' },
      result: 'simulated',
      inputRefs: [`proposal:${proposalId}`, `hash:${request.payloadHash}`],
      proposedPayload: request.payload,
    });
  }

  // --- review queue -------------------------------------------------------
  await ctx.repos.upsertReviewItems(
    persisted
      .filter((f) => f.requiresConsultant)
      .map((f) => ({
        id: `review-${f.id}`,
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        closeRunId: ctx.closeRunId,
        findingId: f.id,
        status: 'queued',
        assignedToUserId: null,
      })),
  );

  // --- how many postings came through clean? ------------------------------
  const touchedVouchers = new Set(
    result.consolidated.map((f) => f.subject.voucherId).filter((v): v is string => Boolean(v)),
  );
  ctx.state.clearItemCount = ruleContext.current.vouchers.filter((v) => !touchedVouchers.has(v.id)).length;

  return {
    status: 'completed',
    message:
      `${result.stats.rawCount} observationer konsoliderades till ${result.stats.consolidatedCount} avvikelser ` +
      `(${result.stats.mergedCount} sammanslagna). ${result.stats.blockingCount} blockerande. ` +
      `${simulated} simulerat Fortnox-anrop.`,
  };
}

function mergedRuleIds(finding: { ruleId: string } & Record<string, unknown>): string[] {
  const merged = finding.mergedFromRuleIds;
  return Array.isArray(merged) ? (merged as string[]) : [finding.ruleId];
}

function occurrencesOf(finding: Record<string, unknown>): number {
  const value = finding.occurrences;
  return typeof value === 'number' ? value : 1;
}

/** Short, stable id fragment from a deduplication key. */
function hashKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
