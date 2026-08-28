import { z } from 'zod';
import { decisionLevelSchema, findingStatusSchema, severitySchema } from './enums.js';

/**
 * Finding taxonomy.
 *
 * Types are split into two families:
 *  - `validation.*` come from the mandatory deterministic bookkeeping
 *    validations. They are always blocking.
 *  - `anomaly.*` come from the explainable anomaly rules. Their severity
 *    depends on the client policy and the amount.
 */
export const findingTypeSchema = z.enum([
  // --- mandatory validations (blocking) ---------------------------------
  'validation.unbalanced_voucher',
  'validation.unknown_or_inactive_account',
  'validation.date_outside_financial_year',
  'validation.period_locked',
  'validation.implausible_vat',
  'validation.input_vat_without_documentation',
  'validation.missing_required_dimension',
  'validation.duplicate_source_record',
  'validation.non_idempotent_action',
  'validation.step_not_implemented',

  // --- anomaly rules ----------------------------------------------------
  'anomaly.unusual_account_for_supplier',
  'anomaly.deviating_vat_code',
  'anomaly.unusual_amount_for_supplier',
  'anomaly.possible_duplicate',
  'anomaly.missing_documentation',
  'anomaly.missing_cost_center_or_project',
  'anomaly.transaction_in_wrong_period',
  'anomaly.manual_voucher_unusual',
  'anomaly.balance_account_where_history_uses_result_account',
  'anomaly.missing_recurring_cost',
]);
export type FindingType = z.infer<typeof findingTypeSchema>;

export function isBlockingType(type: FindingType): boolean {
  return type.startsWith('validation.');
}

/** A pointer to the evidence that made the system react. */
export const evidenceRefSchema = z.object({
  kind: z.enum([
    'voucher',
    'voucher_row',
    'supplier_invoice',
    'customer_invoice',
    'bank_transaction',
    'source_document',
    'account',
    'history_window',
    'rule',
    'imported_record',
  ]),
  /** Stable identifier inside the app database or the Fortnox mirror. */
  ref: z.string().min(1),
  label: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const findingSubjectSchema = z.object({
  accountNumber: z.number().int().optional(),
  voucherId: z.string().optional(),
  voucherRowId: z.string().optional(),
  transactionId: z.string().optional(),
  invoiceId: z.string().optional(),
  supplierNumber: z.string().optional(),
  customerNumber: z.string().optional(),
});
export type FindingSubject = z.infer<typeof findingSubjectSchema>;

export const findingDraftSchema = z.object({
  type: findingTypeSchema,
  severity: severitySchema,
  subject: findingSubjectSchema,
  /** Amount the finding concerns, in öre. */
  amount: z.number().int(),
  /** One-line summary shown in the queue. */
  description: z.string().min(1),
  /** Why the system reacted - the explainable rule rationale, not an LLM answer. */
  rationale: z.string().min(1),
  /** What the consultant is expected to do. */
  suggestedAction: z.string().min(1),
  evidence: z.array(evidenceRefSchema).default([]),
  decisionLevel: decisionLevelSchema,
  decisionScore: z.number().min(0).max(1),
  decisionReasons: z.array(z.string()).default([]),
  requiresConsultant: z.boolean(),
  blocking: z.boolean(),
  /** Identity of the underlying issue. Two checks finding the same thing share it. */
  deduplicationKey: z.string().min(1),
  ruleId: z.string().min(1),
  ruleVersion: z.string().min(1),
});
export type FindingDraft = z.infer<typeof findingDraftSchema>;

export const findingSchema = findingDraftSchema.extend({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  closeRunId: z.string(),
  status: findingStatusSchema,
  /** Rule ids that independently produced this same finding. */
  mergedFromRuleIds: z.array(z.string()).default([]),
  occurrences: z.number().int().min(1).default(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Finding = z.infer<typeof findingSchema>;

const SEVERITY_ORDER: Record<z.infer<typeof severitySchema>, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function maxSeverity(
  a: z.infer<typeof severitySchema>,
  b: z.infer<typeof severitySchema>,
): z.infer<typeof severitySchema> {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

export function severityRank(s: z.infer<typeof severitySchema>): number {
  return SEVERITY_ORDER[s];
}

/**
 * Builds a deduplication key.
 *
 * The key intentionally excludes the rule id: the whole point is that two
 * different rules noticing the same underlying problem collapse into one
 * finding for the consultant.
 */
export function buildDeduplicationKey(parts: {
  clientId: string;
  periodKey: string;
  /** A coarse issue class, e.g. 'missing_documentation' - NOT the rule id. */
  issueClass: string;
  subject: FindingSubject;
}): string {
  const s = parts.subject;
  const subjectKey =
    s.voucherRowId ??
    s.voucherId ??
    s.invoiceId ??
    s.transactionId ??
    [s.supplierNumber, s.customerNumber, s.accountNumber].filter(Boolean).join(':') ??
    'unscoped';
  return [parts.clientId, parts.periodKey, parts.issueClass, subjectKey]
    .map((p) => String(p ?? '').trim().toLowerCase())
    .join('|');
}

/**
 * Consolidates findings by deduplication key.
 *
 * Merge policy: highest severity wins, the most restrictive decision level
 * wins, evidence is unioned, and the rule ids that contributed are recorded so
 * the review UI can show "3 checks reacted to this".
 */
export function consolidateFindings(drafts: readonly FindingDraft[]): FindingDraft[] {
  const byKey = new Map<string, FindingDraft & { mergedFromRuleIds: string[]; occurrences: number }>();

  const levelRank: Record<z.infer<typeof decisionLevelSchema>, number> = {
    automatic: 0,
    review: 1,
    manual_assessment: 2,
  };

  for (const draft of drafts) {
    const existing = byKey.get(draft.deduplicationKey);
    if (!existing) {
      byKey.set(draft.deduplicationKey, {
        ...draft,
        mergedFromRuleIds: [draft.ruleId],
        occurrences: 1,
      });
      continue;
    }

    const keepIncomingLevel = levelRank[draft.decisionLevel] > levelRank[existing.decisionLevel];
    const merged: FindingDraft & { mergedFromRuleIds: string[]; occurrences: number } = {
      ...existing,
      severity: maxSeverity(existing.severity, draft.severity),
      blocking: existing.blocking || draft.blocking,
      requiresConsultant: existing.requiresConsultant || draft.requiresConsultant,
      decisionLevel: keepIncomingLevel ? draft.decisionLevel : existing.decisionLevel,
      // The lowest score is the safest: it keeps the item in front of a human.
      decisionScore: Math.min(existing.decisionScore, draft.decisionScore),
      decisionReasons: dedupeStrings([...existing.decisionReasons, ...draft.decisionReasons]),
      evidence: dedupeEvidence([...existing.evidence, ...draft.evidence]),
      rationale:
        existing.rationale === draft.rationale
          ? existing.rationale
          : `${existing.rationale}\n${draft.rationale}`,
      mergedFromRuleIds: dedupeStrings([...existing.mergedFromRuleIds, draft.ruleId]),
      occurrences: existing.occurrences + 1,
    };
    byKey.set(draft.deduplicationKey, merged);
  }

  return [...byKey.values()].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      Math.abs(b.amount) - Math.abs(a.amount) ||
      a.deduplicationKey.localeCompare(b.deduplicationKey),
  );
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeEvidence(values: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  for (const v of values) seen.set(`${v.kind}:${v.ref}`, v);
  return [...seen.values()];
}
