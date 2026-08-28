import { type AuditOperation, redactAuditPayload } from '@trimeros/domain';
import type { Repositories } from '@trimeros/db';

export interface AuditWriterInput {
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly closeRunId: string | null;
  readonly correlationId: string;
}

export interface AuditEntry {
  readonly operation: AuditOperation;
  readonly actor: { readonly kind: 'system' | 'user' | 'model' | 'scheduler'; readonly id: string };
  readonly result: 'ok' | 'blocked' | 'error' | 'simulated';
  readonly inputRefs?: readonly string[];
  readonly ruleVersion?: string | null;
  readonly promptVersion?: string | null;
  readonly modelProvider?: string | null;
  readonly modelName?: string | null;
  readonly toolCall?: string | null;
  readonly proposedPayload?: unknown;
  readonly approvedPayload?: unknown;
  readonly fortnoxId?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

/**
 * Appends to the audit log, always through `redactAuditPayload`.
 *
 * There is no path in the codebase that writes an audit event without passing
 * through this function, which is what makes "no secrets and no documents in
 * the audit log" a property of the system rather than a convention.
 */
export function createAuditWriter(repos: Repositories, base: AuditWriterInput) {
  return async function audit(entry: AuditEntry): Promise<void> {
    await repos.appendAuditEvent({
      tenantId: base.tenantId,
      clientId: base.clientId,
      closeRunId: base.closeRunId,
      actorKind: entry.actor.kind,
      actorId: entry.actor.id,
      occurredAt: new Date(),
      operation: entry.operation,
      inputRefs: [...(entry.inputRefs ?? [])],
      ruleVersion: entry.ruleVersion ?? null,
      promptVersion: entry.promptVersion ?? null,
      modelProvider: entry.modelProvider ?? null,
      modelName: entry.modelName ?? null,
      toolCall: entry.toolCall ?? null,
      proposedPayload:
        entry.proposedPayload === undefined ? null : redactAuditPayload(entry.proposedPayload),
      approvedPayload:
        entry.approvedPayload === undefined ? null : redactAuditPayload(entry.approvedPayload),
      result: entry.result,
      fortnoxId: entry.fortnoxId ?? null,
      errorCode: entry.errorCode ?? null,
      errorMessage: entry.errorMessage ?? null,
      correlationId: base.correlationId,
    });
  };
}

export type AuditWriter = ReturnType<typeof createAuditWriter>;
