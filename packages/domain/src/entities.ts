import { z } from 'zod';
import {
  approvalDecisionKindSchema,
  closeRunStatusSchema,
  customerRequestStatusSchema,
  decisionLevelSchema,
  importedRecordKindSchema,
  integrationKindSchema,
  integrationModeSchema,
  periodStatusSchema,
  proposalStatusSchema,
  reviewItemStatusSchema,
  sourceDocumentKindSchema,
  stepStatusSchema,
} from './enums.js';
import { isoDateSchema, periodKeySchema } from './period.js';
import { workflowStepKeySchema } from './workflow-steps.js';

/**
 * Business entities.
 *
 * Every entity below is tenant-isolated: `tenantId` (the accounting firm) is
 * mandatory and is part of every index and every query path. `clientId` scopes
 * to the end client. See docs/security-and-permissions.md.
 */

export const firmSchema = z.object({
  id: z.string(),
  name: z.string(),
  organisationNumber: z.string().nullable(),
  createdAt: z.date(),
});
export type Firm = z.infer<typeof firmSchema>;

export const userRoleSchema = z.enum(['owner', 'consultant', 'reviewer', 'read_only']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  role: userRoleSchema,
  active: z.boolean(),
  createdAt: z.date(),
});
export type User = z.infer<typeof userSchema>;

export const clientSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  organisationNumber: z.string(),
  /** Fortnox company id / tenant reference. Never a credential. */
  fortnoxCompanyRef: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.date(),
});
export type Client = z.infer<typeof clientSchema>;

/**
 * Per-client accounting policy: the thresholds and requirements that turn a
 * generic engine into "how this client is actually handled".
 */
export const clientAccountingPolicySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  /** Above this (öre) an item is material and always goes to manual assessment. */
  materialityThreshold: z.number().int().min(0),
  /** Above this (öre) automatic handling is never allowed. */
  automationAmountLimit: z.number().int().min(0),
  /** Accounts (or ranges) that must carry a cost center. */
  costCenterRequiredAccounts: z.array(z.number().int()).default([]),
  projectRequiredAccounts: z.array(z.number().int()).default([]),
  /** Input VAT is never proposed without documentation when true. */
  requireDocumentationForInputVat: z.boolean().default(true),
  /** Number of prior periods used as the history window for anomaly rules. */
  historyWindowMonths: z.number().int().min(1).max(36).default(12),
  /** Relative deviation above which an amount counts as unusual (0.5 = 50%). */
  amountDeviationThreshold: z.number().min(0).default(0.5),
  vatRates: z.array(z.number()).default([0, 0.06, 0.12, 0.25]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ClientAccountingPolicy = z.infer<typeof clientAccountingPolicySchema>;

/** A deterministic, client-specific rule. Never free-text interpreted by an LLM. */
export const clientRuleKindSchema = z.enum([
  'supplier_account_mapping',
  'recurring_cost',
  'vat_code_for_account',
  'dimension_requirement',
  'ignore_account',
]);
export type ClientRuleKind = z.infer<typeof clientRuleKindSchema>;

export const clientRuleSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  kind: clientRuleKindSchema,
  version: z.string(),
  active: z.boolean().default(true),
  /** Structured, validated rule configuration. Shape depends on `kind`. */
  config: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
});
export type ClientRule = z.infer<typeof clientRuleSchema>;

export const accountingPeriodSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  periodKey: periodKeySchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  status: periodStatusSchema,
  /** Mirrors the Fortnox locked-period state. Never written to by phase 1. */
  fortnoxLockedThrough: isoDateSchema.nullable().default(null),
  createdAt: z.date(),
});
export type AccountingPeriod = z.infer<typeof accountingPeriodSchema>;

export const closeRunSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  periodId: z.string(),
  periodKey: periodKeySchema,
  status: closeRunStatusSchema,
  /** True for every run in phase 1. */
  shadowMode: z.boolean().default(true),
  ruleSetVersion: z.string(),
  decisionModelVersion: z.string(),
  correlationId: z.string(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type CloseRun = z.infer<typeof closeRunSchema>;

export const closeRunStepSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  closeRunId: z.string(),
  stepKey: workflowStepKeySchema,
  order: z.number().int(),
  status: stepStatusSchema,
  /** Short machine-readable reason for a blocked/failed/not_implemented state. */
  reasonCode: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  attempt: z.number().int().min(0).default(0),
  /** Idempotency key: re-running a step with the same key is a no-op. */
  idempotencyKey: z.string(),
});
export type CloseRunStep = z.infer<typeof closeRunStepSchema>;

export const sourceDocumentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  kind: sourceDocumentKindSchema,
  /** Reference into Fortnox archive/inbox. The file itself is never copied here. */
  externalRef: z.string().nullable(),
  fileName: z.string().nullable(),
  received: z.boolean(),
  createdAt: z.date(),
});
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const importedRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  closeRunId: z.string().nullable(),
  kind: importedRecordKindSchema,
  /** Identifier in Fortnox. Together with kind + client this is unique. */
  externalId: z.string(),
  periodKey: periodKeySchema.nullable(),
  /** Normalised payload, validated against the ledger schemas. */
  payload: z.unknown(),
  /** Hash of the upstream payload, used for change detection and idempotency. */
  contentHash: z.string(),
  importedAt: z.date(),
});
export type ImportedRecord = z.infer<typeof importedRecordSchema>;

export const transactionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  periodKey: periodKeySchema,
  transactionDate: isoDateSchema,
  account: z.number().int(),
  debit: z.number().int(),
  credit: z.number().int(),
  description: z.string(),
  costCenter: z.string().nullable(),
  project: z.string().nullable(),
  vatCode: z.string().nullable(),
  voucherId: z.string(),
  voucherRowId: z.string(),
  supplierNumber: z.string().nullable(),
  customerNumber: z.string().nullable(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const bookingProposalRowSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  account: z.number().int(),
  debit: z.number().int().min(0),
  credit: z.number().int().min(0),
  description: z.string(),
  costCenter: z.string().nullable(),
  project: z.string().nullable(),
  vatCode: z.string().nullable(),
});
export type BookingProposalRow = z.infer<typeof bookingProposalRowSchema>;

export const bookingProposalSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  closeRunId: z.string(),
  findingId: z.string().nullable(),
  status: proposalStatusSchema,
  decisionLevel: decisionLevelSchema,
  decisionScore: z.number().min(0).max(1),
  transactionDate: isoDateSchema,
  series: z.string(),
  description: z.string(),
  /** Exact payload that WOULD be sent to Fortnox. Never actually sent in phase 1. */
  simulatedFortnoxPayload: z.unknown(),
  /** Target endpoint the payload would be sent to, for transparency. */
  simulatedFortnoxEndpoint: z.string(),
  createdAt: z.date(),
  rows: z.array(bookingProposalRowSchema).default([]),
});
export type BookingProposal = z.infer<typeof bookingProposalSchema>;

export const reconciliationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  closeRunId: z.string(),
  account: z.number().int(),
  periodKey: periodKeySchema,
  ledgerBalance: z.number().int(),
  externalBalance: z.number().int().nullable(),
  difference: z.number().int(),
  status: z.enum(['open', 'matched', 'unmatched', 'not_implemented']),
  createdAt: z.date(),
});
export type Reconciliation = z.infer<typeof reconciliationSchema>;

export const reconciliationItemSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  reconciliationId: z.string(),
  reference: z.string(),
  amount: z.number().int(),
  matched: z.boolean(),
  note: z.string().nullable(),
});
export type ReconciliationItem = z.infer<typeof reconciliationItemSchema>;

export const reviewItemSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  closeRunId: z.string(),
  findingId: z.string(),
  status: reviewItemStatusSchema,
  assignedToUserId: z.string().nullable(),
  queuedAt: z.date(),
  decidedAt: z.date().nullable(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const customerRequestSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  closeRunId: z.string(),
  findingId: z.string().nullable(),
  status: customerRequestStatusSchema,
  subject: z.string(),
  body: z.string(),
  /** Always null in phase 1: nothing is ever sent. */
  sentAt: z.date().nullable(),
  createdAt: z.date(),
});
export type CustomerRequest = z.infer<typeof customerRequestSchema>;

export const approvalDecisionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  reviewItemId: z.string(),
  findingId: z.string(),
  proposalId: z.string().nullable(),
  kind: approvalDecisionKindSchema,
  decidedByUserId: z.string(),
  comment: z.string().nullable(),
  /** For `edit_proposal`: the edited rows the consultant approved. */
  editedPayload: z.unknown().nullable(),
  /** Always true in phase 1 - an approval changes internal state only. */
  shadowOnly: z.boolean().default(true),
  createdAt: z.date(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const integrationConnectionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  clientId: z.string(),
  kind: integrationKindSchema,
  mode: integrationModeSchema,
  /** Granted scopes, mirrored for readiness checks. Not a credential. */
  scopes: z.array(z.string()).default([]),
  /**
   * Reference to the credential in the secret store. The secret value itself is
   * never stored in this database and is never exposed to a model provider.
   */
  credentialRef: z.string().nullable(),
  writesEnabled: z.boolean().default(false),
  healthy: z.boolean().default(true),
  lastCheckedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;
