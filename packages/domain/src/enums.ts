import { z } from 'zod';

/** Lifecycle of a single close run (one client, one period, one attempt). */
export const closeRunStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_review',
  'completed',
  'blocked',
  'failed',
]);
export type CloseRunStatus = z.infer<typeof closeRunStatusSchema>;

/**
 * Status of an individual workflow step.
 *
 * `not_implemented` is a first-class state on purpose: phase 1 only implements
 * part of the target process, and the system must never report a period as
 * complete while unimplemented steps still carry real accounting work.
 */
export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'blocked',
  'not_implemented',
  'failed',
  'skipped',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const periodStatusSchema = z.enum(['open', 'closing', 'closed', 'locked']);
export type PeriodStatus = z.infer<typeof periodStatusSchema>;

/** The three-level decision model. See docs/accounting-decision-model.md. */
export const decisionLevelSchema = z.enum(['automatic', 'review', 'manual_assessment']);
export type DecisionLevel = z.infer<typeof decisionLevelSchema>;

export const severitySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof severitySchema>;

export const findingStatusSchema = z.enum([
  'open',
  'in_review',
  'approved',
  'rejected',
  'information_requested',
  'resolved',
  'superseded',
]);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export const reviewItemStatusSchema = z.enum(['queued', 'in_review', 'decided', 'dismissed']);
export type ReviewItemStatus = z.infer<typeof reviewItemStatusSchema>;

export const approvalDecisionKindSchema = z.enum([
  'approve',
  'reject',
  'edit_proposal',
  'request_information',
]);
export type ApprovalDecisionKind = z.infer<typeof approvalDecisionKindSchema>;

export const proposalStatusSchema = z.enum([
  'draft',
  'proposed',
  'approved_shadow',
  'rejected',
  'simulated',
  'submitted',
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const sourceDocumentKindSchema = z.enum([
  'supplier_invoice',
  'customer_invoice',
  'receipt',
  'bank_statement',
  'contract',
  'tax_account_statement',
  'other',
]);
export type SourceDocumentKind = z.infer<typeof sourceDocumentKindSchema>;

export const importedRecordKindSchema = z.enum([
  'voucher',
  'account',
  'customer_invoice',
  'supplier_invoice',
  'invoice_payment',
  'supplier_invoice_payment',
  'bank_transaction',
  'customer',
  'supplier',
  'cost_center',
  'project',
  'financial_year',
  'voucher_series',
]);
export type ImportedRecordKind = z.infer<typeof importedRecordKindSchema>;

export const integrationKindSchema = z.enum(['fortnox']);
export type IntegrationKind = z.infer<typeof integrationKindSchema>;

export const integrationModeSchema = z.enum(['mock', 'real_read_only', 'real_read_write']);
export type IntegrationMode = z.infer<typeof integrationModeSchema>;

export const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'revenue', 'cost']);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const customerRequestStatusSchema = z.enum(['draft', 'ready_to_send', 'sent', 'answered', 'cancelled']);
export type CustomerRequestStatus = z.infer<typeof customerRequestStatusSchema>;
