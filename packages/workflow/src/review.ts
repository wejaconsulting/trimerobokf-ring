import { randomUUID } from 'node:crypto';
import type { Repositories } from '@trimeros/db';
import type { ApprovalDecisionKind } from '@trimeros/domain';
import { createAuditWriter } from './audit.js';

/**
 * Review decisions.
 *
 * An approval here changes internal review state and nothing else. It does not
 * post to Fortnox, does not unlock a period and does not send an email - and it
 * cannot, because this module has no Fortnox adapter and no mail client in
 * scope. `shadowOnly` is written as `true` on every decision so the record
 * itself carries that fact for anyone auditing it later.
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
  const proposalId = proposals[0]?.id ?? null;

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
    comment: input.comment ?? null,
    editedPayload: input.editedPayload ?? null,
    // Phase 1: an approval is always shadow-only.
    shadowOnly: true,
  });

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
    inputRefs: [`finding:${input.findingId}`, `kind:${input.kind}`, `shadow_only:true`],
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
