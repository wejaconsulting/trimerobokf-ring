import { z } from 'zod';

/**
 * The audit log.
 *
 * Two hard rules, enforced by `redactAuditPayload` and asserted by unit tests:
 *  1. No secrets. Tokens, client secrets and API keys never reach this table.
 *  2. No documents and no sensitive free text. Only references and structured,
 *     bounded values - a payload preview, not an archive.
 */

export const auditOperationSchema = z.enum([
  'close_run.created',
  'close_run.step_started',
  'close_run.step_completed',
  'close_run.step_blocked',
  'close_run.step_failed',
  'close_run.completed',
  'import.records_ingested',
  'rules.evaluated',
  'finding.created',
  'finding.consolidated',
  'proposal.created',
  'proposal.simulated',
  'review.decision_recorded',
  'agent.model_invoked',
  'fortnox.read',
  'fortnox.write_simulated',
  'fortnox.write_blocked',
  'fortnox.write_submitted',
  'fortnox.write_failed',
  'review.auto_approved',
  'policy.updated',
  'client.created',
  'integration.writes_toggled',
  'integration.readiness_checked',
]);
export type AuditOperation = z.infer<typeof auditOperationSchema>;

export const auditActorSchema = z.object({
  kind: z.enum(['system', 'user', 'model', 'scheduler']),
  /** User id, provider name or 'workflow-engine'. Never an email in phase 1. */
  id: z.string(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string().nullable(),
  closeRunId: z.string().nullable(),
  actor: auditActorSchema,
  occurredAt: z.date(),
  operation: auditOperationSchema,
  /** References to the inputs, never the inputs themselves. */
  inputRefs: z.array(z.string()).default([]),
  ruleVersion: z.string().nullable(),
  promptVersion: z.string().nullable(),
  modelProvider: z.string().nullable(),
  modelName: z.string().nullable(),
  toolCall: z.string().nullable(),
  /** The payload the system proposed to send to Fortnox. */
  proposedPayload: z.unknown().nullable(),
  /** The payload a human approved, when different from the proposal. */
  approvedPayload: z.unknown().nullable(),
  result: z.enum(['ok', 'blocked', 'error', 'simulated']),
  /** Fortnox identifier when a real write eventually happens. Null in shadow mode. */
  fortnoxId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  correlationId: z.string(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Keys whose values must never be persisted to the audit log. */
export const FORBIDDEN_AUDIT_KEYS: readonly string[] = [
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'apikey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'token',
  'credential',
  'filecontent',
  'file_content',
  'filedata',
  'base64',
  'attachment',
  'personalnumber',
  'personnummer',
];

const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 6;

/**
 * Redacts a payload for audit storage: strips forbidden keys, truncates long
 * strings (a document body must not sneak in as free text) and bounds depth.
 */
export function redactAuditPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > MAX_DEPTH) return '[truncated:depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated:${value.length}]`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const capped = value.slice(0, 200).map((v) => redactAuditPayload(v, depth + 1));
    if (value.length > 200) capped.push(`[truncated:${value.length - 200} more]`);
    return capped;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_AUDIT_KEYS.includes(k.toLowerCase())) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = redactAuditPayload(v, depth + 1);
    }
    return out;
  }

  return '[unsupported]';
}

export function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsForbiddenKey(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_AUDIT_KEYS.includes(k.toLowerCase())) return true;
    if (containsForbiddenKey(v, depth + 1)) return true;
  }
  return false;
}
