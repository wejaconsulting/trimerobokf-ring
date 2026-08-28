/**
 * The write gate.
 *
 * Phase 1 is strictly shadow mode. Rather than "no write code exists", the
 * write path exists but is guarded by three independent conditions that must
 * ALL hold. A single environment variable is never enough.
 */

export class FortnoxWriteBlockedError extends Error {
  override readonly name = 'FortnoxWriteBlockedError';
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Fortnox write blocked: ${reasons.join('; ')}`);
    this.reasons = reasons;
  }
}

export interface WriteContext {
  /** Feature flag, from configuration. False in phase 1. */
  readonly featureFlagEnabled: boolean;
  /** Global shadow-mode switch. True in phase 1. */
  readonly shadowMode: boolean;
  /**
   * Id of a persisted, human-made ApprovalDecision authorising this exact
   * payload. A run without one can never write, whatever the flags say.
   */
  readonly approvalDecisionId: string | null;
  /** True when a human explicitly approved *this* payload hash. */
  readonly approvedPayloadHash: string | null;
  readonly payloadHash: string;
  /** Policy checks evaluated by the rules engine, not by the adapter. */
  readonly policy: {
    readonly periodOpen: boolean;
    readonly validationsPassed: boolean;
    readonly clientWritesEnabled: boolean;
  };
}

export interface WriteGateResult {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export function evaluateWriteGate(ctx: WriteContext): WriteGateResult {
  const reasons: string[] = [];

  if (ctx.shadowMode) reasons.push('shadow_mode_active');
  if (!ctx.featureFlagEnabled) reasons.push('feature_flag_disabled');
  if (!ctx.policy.clientWritesEnabled) reasons.push('client_writes_disabled');
  if (!ctx.approvalDecisionId) reasons.push('no_human_approval');
  if (!ctx.approvedPayloadHash) reasons.push('no_approved_payload_hash');
  else if (ctx.approvedPayloadHash !== ctx.payloadHash) reasons.push('payload_changed_since_approval');
  if (!ctx.policy.periodOpen) reasons.push('period_not_open');
  if (!ctx.policy.validationsPassed) reasons.push('validations_failed');

  return { allowed: reasons.length === 0, reasons };
}

export function assertWriteAllowed(ctx: WriteContext): void {
  const result = evaluateWriteGate(ctx);
  if (!result.allowed) throw new FortnoxWriteBlockedError(result.reasons);
}

/** Stable, order-independent hash of a payload, used to bind approvals to bytes. */
export function hashPayload(payload: unknown): string {
  const json = stableStringify(payload);
  // FNV-1a, 64-bit, expressed as hex. Sufficient for change detection; this is
  // an integrity check against accidental drift, not a security primitive.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(json)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
