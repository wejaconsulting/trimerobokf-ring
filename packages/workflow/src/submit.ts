import type { ProposalRow, Repositories } from '@trimeros/db';
import { periodKeyOf } from '@trimeros/domain';
import {
  FortnoxApiError,
  FortnoxWriteBlockedError,
  evaluateWriteGate,
  hashPayload,
  type FortnoxDataSource,
  type FortnoxWritePort,
  type VoucherCreatePayload,
  type WriteContext,
} from '@trimeros/fortnox';
import { createAuditWriter } from './audit.js';

/**
 * Submission: the one code path that can turn an approved proposal into a
 * voucher in a real Fortnox account.
 *
 * It is deliberately small and deliberately boring. For every proposal it
 * builds the seven-condition `WriteContext`, asks the gate, and only if the
 * gate says yes claims the proposal (compare-and-set), posts it, and records
 * the Fortnox reference. Every other outcome - shadow mode, no approval, a
 * changed payload, a locked period, a client whose writes are off - is a
 * `fortnox.write_blocked` audit event with the reasons, and the proposal stays
 * where it was.
 */

export interface SubmissionInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly closeRunId: string;
  readonly correlationId: string;
  readonly dataSource: FortnoxDataSource;
  readonly shadowMode: boolean;
  readonly featureFlagEnabled: boolean;
  /** Only proposals with these ids; every approved proposal in the run when omitted. */
  readonly proposalIds?: readonly string[];
}

export interface SubmissionResult {
  readonly submitted: readonly { proposalId: string; fortnoxVoucherId: string; reference: string }[];
  readonly blocked: readonly { proposalId: string; reasons: readonly string[] }[];
  readonly failed: readonly { proposalId: string; error: string }[];
}

export async function submitApprovedProposals(
  repos: Repositories,
  input: SubmissionInput,
): Promise<SubmissionResult> {
  const scope = { tenantId: input.tenantId };
  const clientScope = { tenantId: input.tenantId, clientId: input.clientId };
  const audit = createAuditWriter(repos, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    closeRunId: input.closeRunId,
    correlationId: input.correlationId,
  });

  const submitted: { proposalId: string; fortnoxVoucherId: string; reference: string }[] = [];
  const blocked: { proposalId: string; reasons: readonly string[] }[] = [];
  const failed: { proposalId: string; error: string }[] = [];

  const candidates = (await repos.listProposalsByStatus(scope, input.closeRunId, ['approved_shadow'])).filter(
    (p) => !input.proposalIds || input.proposalIds.includes(p.id),
  );
  if (candidates.length === 0) return { submitted, blocked, failed };

  // The client's own write switch, from the connection the run reads from.
  const connection =
    input.dataSource.kind === 'real'
      ? await repos.getIntegrationConnection(clientScope, 'fortnox_oauth')
      : undefined;
  const clientWritesEnabled = connection?.writesEnabled ?? false;

  // The lock is read fresh at submission time, not from the run: a consultant
  // may have locked the period in Fortnox since the analysis ran.
  let lockedThrough: string | null = null;
  if (input.dataSource.kind !== 'none') {
    try {
      lockedThrough = (await input.dataSource.port.getLockedPeriod()).lockedThrough;
    } catch {
      lockedThrough = null;
    }
  }

  const writer = input.dataSource.port as Partial<FortnoxWritePort>;
  const alreadyBooked = new Set(await repos.listProcessedSourceKeys(clientScope));

  for (const proposal of candidates) {
    const decision = await latestApproval(repos, input.tenantId, proposal);
    const payload = payloadFor(proposal, decision?.editedPayload);
    const payloadHash = hashPayload(payload);

    // The same bytes were booked by an earlier run of this client. A re-run
    // regenerates proposals, so this is the check that makes re-running safe.
    if (alreadyBooked.has(bookedKey(payloadHash))) {
      await repos.updateProposal(scope, proposal.id, { status: 'already_booked' });
      blocked.push({ proposalId: proposal.id, reasons: ['already_booked_in_earlier_run'] });
      await audit({
        operation: 'fortnox.write_blocked',
        actor: { kind: 'system', id: 'submission' },
        result: 'blocked',
        inputRefs: [`proposal:${proposal.id}`, `hash:${payloadHash}`, 'reason:already_booked_in_earlier_run'],
      });
      continue;
    }

    const context: WriteContext = {
      featureFlagEnabled: input.featureFlagEnabled,
      shadowMode: input.shadowMode,
      approvalDecisionId: decision?.id ?? null,
      approvedPayloadHash: decision?.approvedPayloadHash ?? null,
      payloadHash,
      policy: {
        periodOpen: lockedThrough === null || proposal.transactionDate > lockedThrough,
        validationsPassed: payloadBalances(payload),
        clientWritesEnabled,
      },
    };

    const gate = evaluateWriteGate(context);
    const canWrite = input.dataSource.kind === 'real' && typeof writer.createVoucher === 'function';
    if (!gate.allowed || !canWrite) {
      const reasons = canWrite ? gate.reasons : [...gate.reasons, 'data_source_not_real'];
      blocked.push({ proposalId: proposal.id, reasons });
      await audit({
        operation: 'fortnox.write_blocked',
        actor: { kind: 'system', id: 'submission' },
        result: 'blocked',
        inputRefs: [`proposal:${proposal.id}`, `hash:${payloadHash}`, ...reasons.map((r) => `reason:${r}`)],
      });
      continue;
    }

    // Claim before posting. If another submitter got here first the CAS
    // returns nothing and this loop moves on - no second voucher.
    const claimed = await repos.claimProposalForSubmission(scope, proposal.id);
    if (!claimed) continue;

    try {
      if (typeof writer.createVoucher !== 'function') throw new FortnoxWriteBlockedError(['adapter_cannot_write']);
      const created = await writer.createVoucher(payload, context);
      const reference = 'reference' in created && typeof created.reference === 'string' ? created.reference : created.id;
      await repos.updateProposal(scope, proposal.id, {
        status: 'submitted',
        fortnoxVoucherId: created.id,
        fortnoxReference: reference,
        approvalDecisionId: decision?.id ?? null,
        submittedAt: new Date(),
        submissionError: null,
      });
      // These bytes are now booked; a re-run must never book them again.
      await repos.recordProcessedSourceKeys(clientScope, input.closeRunId, [bookedKey(payloadHash)]);
      submitted.push({ proposalId: proposal.id, fortnoxVoucherId: created.id, reference });
      await audit({
        operation: 'fortnox.write_submitted',
        actor: { kind: 'system', id: 'submission' },
        result: 'ok',
        inputRefs: [
          `proposal:${proposal.id}`,
          `approval:${decision?.id ?? 'none'}`,
          `hash:${payloadHash}`,
          `period:${periodKeyOf(proposal.transactionDate)}`,
        ],
        approvedPayload: payload,
        fortnoxId: created.id,
      });
    } catch (error) {
      const message = describeError(error);
      await repos.updateProposal(scope, proposal.id, {
        status: 'submission_failed',
        submissionError: message.slice(0, 500),
      });
      failed.push({ proposalId: proposal.id, error: message });
      await audit({
        operation: 'fortnox.write_failed',
        actor: { kind: 'system', id: 'submission' },
        result: 'error',
        inputRefs: [`proposal:${proposal.id}`, `hash:${payloadHash}`],
        errorCode: error instanceof FortnoxApiError ? `http_${error.status}` : 'submit_failed',
        errorMessage: message.slice(0, 500),
      });
    }
  }

  return { submitted, blocked, failed };
}

/** Processed-source key recording that a payload hash has been booked. */
export function bookedKey(payloadHash: string): string {
  return `booked:${payloadHash}`;
}

/** The most recent approve/edit decision for the proposal's finding. */
async function latestApproval(repos: Repositories, tenantId: string, proposal: ProposalRow) {
  if (!proposal.findingId) return undefined;
  const decisions = await repos.listApprovalDecisions({ tenantId }, proposal.findingId);
  return [...decisions]
    .reverse()
    .find((d) => (d.kind === 'approve' || d.kind === 'edit_proposal') && d.approvedPayloadHash);
}

/**
 * The payload to send: the consultant's edited version when the decision
 * carries one, otherwise the exact payload the proposal simulated.
 */
export function payloadFor(proposal: ProposalRow, editedPayload: unknown): VoucherCreatePayload {
  if (isVoucherPayload(editedPayload)) return editedPayload;
  const simulated = proposal.simulatedFortnoxPayload;
  if (isVoucherPayload(simulated)) return simulated;
  throw new FortnoxWriteBlockedError(['proposal_has_no_payload']);
}

function isVoucherPayload(value: unknown): value is VoucherCreatePayload {
  if (!value || typeof value !== 'object') return false;
  const voucher = (value as { Voucher?: unknown }).Voucher;
  if (!voucher || typeof voucher !== 'object') return false;
  const rows = (voucher as { VoucherRows?: unknown }).VoucherRows;
  return Array.isArray(rows) && rows.length > 0;
}

export function payloadBalances(payload: VoucherCreatePayload): boolean {
  let debit = 0;
  let credit = 0;
  for (const row of payload.Voucher.VoucherRows) {
    if (!Number.isFinite(row.Debit) || !Number.isFinite(row.Credit) || row.Debit < 0 || row.Credit < 0) return false;
    debit += Math.round(row.Debit * 100);
    credit += Math.round(row.Credit * 100);
  }
  return debit === credit && debit > 0;
}

function describeError(error: unknown): string {
  if (error instanceof FortnoxWriteBlockedError) return error.message;
  if (error instanceof FortnoxApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
