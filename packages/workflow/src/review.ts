import { randomUUID } from 'node:crypto';
import type { Repositories } from '@trimeros/db';
import type { ApprovalDecisionKind } from '@trimeros/domain';
import { hashPayload } from '@trimeros/fortnox';
import { createAuditWriter } from './audit.js';

/**
 * Review decisions.
 *
 * An approval here changes internal review state and nothing else. It does not
 * post to Fortnox, does not unlock a period and does not send an email - and it
 * cannot, because this module has no Fortnox adapter and no mail client in
 * scope. `shadowOnly` is written as `true` on every decision so the record
 * itself carries that fact for anyone auditing it later.
 *
 * What an approval *does* carry is the hash of the exact payload the person
 * approved. Booking is a separate, later step (`submitApprovedProposals`)
 * that re-hashes the payload and refuses if a single byte differs.
 */

export interface RecordDecisionInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly findingId: string;
  readonly kind: ApprovalDecisionKind;
  readonly decidedByUserId: string;
  readonly comment?: string | null;
  /** For `edit_proposal`: the rows the consultant actually approved. */
  readonly editedPayload?: unknown;
}

export interface RecordDecisionResult {
  readonly approvalDecisionId: string;
  readonly findingStatus: string;
  readonly reviewItemStatus: string;
  readonly shadowOnly: true;
  readonly note: string;
}

const FINDING_STATUS_BY_KIND: Record<ApprovalDecisionKind, string> = {
  approve: 'approved',
  reject: 'rejected',
  edit_proposal: 'approved',
  request_information: 'information_requested',
};

const REVIEW_STATUS_BY_KIND: Record<ApprovalDecisionKind, string> = {
  approve: 'decided',
  reject: 'decided',
  edit_proposal: 'decided',
  request_information: 'in_review',
};

export async function recordReviewDecision(
  repos: Repositories,
  input: RecordDecisionInput,
): Promise<RecordDecisionResult> {
  const scope = { tenantId: input.tenantId };

  const finding = await repos.getFinding(scope, input.findingId);
  if (!finding) throw new Error(`Unknown finding ${input.findingId}`);

  const reviewItem = await repos.getReviewItemForFinding(scope, input.findingId);
  if (!reviewItem) throw new Error(`Finding ${input.findingId} has no review item`);

  const proposals = await repos.listProposalsForFinding(scope, input.findingId);
  const proposal = proposals[0];
  const proposalId = proposal?.id ?? null;

  // The bytes this decision approves. An edited proposal binds to the edited
  // payload; a plain approval binds to the payload that was simulated.
  const approvedPayload =
    input.kind === 'edit_proposal' && input.editedPayload
      ? input.editedPayload
      : input.kind === 'approve'
        ? (proposal?.simulatedFortnoxPayload ?? null)
        : null;
  const approvedPayloadHash = approvedPayload ? hashPayload(approvedPayload) : null;

  const approvalDecisionId = randomUUID();
  await repos.insertApprovalDecision({
    id: approvalDecisionId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    reviewItemId: reviewItem.id,
    findingId: input.findingId,
    proposalId,
    kind: input.kind,
    decidedByUserId: input.decidedByUserId,
    actorKind: 'user',
    comment: input.comment ?? null,
    editedPayload: input.editedPayload ?? null,
    approvedPayloadHash,
    // The decision itself never writes to Fortnox.
    shadowOnly: true,
  });

  if (proposal) {
    const proposalStatus =
      input.kind === 'approve' || input.kind === 'edit_proposal'
        ? 'approved_shadow'
        : input.kind === 'reject'
          ? 'rejected'
          : null;
    if (proposalStatus && proposal.status !== 'submitted') {
      await repos.updateProposal(scope, proposal.id, { status: proposalStatus });
    }
  }

  const findingStatus = FINDING_STATUS_BY_KIND[input.kind];
  const reviewItemStatus = REVIEW_STATUS_BY_KIND[input.kind];

  await repos.updateFindingStatus(scope, input.findingId, findingStatus);
  await repos.updateReviewItem(scope, reviewItem.id, {
    status: reviewItemStatus,
    decidedAt: reviewItemStatus === 'decided' ? new Date() : null,
  });

  if (input.kind === 'request_information') {
    await repos.insertCustomerRequest({
      id: randomUUID(),
      tenantId: input.tenantId,
      clientId: input.clientId,
      closeRunId: finding.closeRunId,
      findingId: input.findingId,
      // Never `sent`: phase 1 does not send customer email.
      status: 'draft',
      subject: `Underlag saknas: ${finding.description}`,
      body: [
        'Hej,',
        '',
        `Inför avstämningen behöver vi underlag för följande post:`,
        `- ${finding.description}`,
        '',
        finding.suggestedAction,
      ].join('\n'),
      sentAt: null,
    });
  }

  const audit = createAuditWriter(repos, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    closeRunId: finding.closeRunId,
    correlationId: `review-${input.findingId}`,
  });
  await audit({
    operation: 'review.decision_recorded',
    actor: { kind: 'user', id: input.decidedByUserId },
    result: 'ok',
    inputRefs: [
      `finding:${input.findingId}`,
      `kind:${input.kind}`,
      `shadow_only:true`,
      ...(approvedPayloadHash ? [`approved_hash:${approvedPayloadHash}`] : []),
    ],
    ruleVersion: finding.ruleVersion,
    approvedPayload: input.editedPayload ?? null,
  });

  return {
    approvalDecisionId,
    findingStatus,
    reviewItemStatus,
    shadowOnly: true,
    note: 'Beslutet ändrar endast intern review-status. Ingenting har skickats till Fortnox.',
  };
}
