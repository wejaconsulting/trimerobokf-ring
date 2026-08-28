import { z } from 'zod';

/**
 * The 14 steps of the target month/quarter close process.
 *
 * Every step exists in the state machine from day one. Steps that phase 1 does
 * not implement are executed as `not_implemented`, which is a *blocking* state
 * for period completion whenever the step carries real accounting work
 * (`blocksCompletion: true`). This is what stops the system from claiming a
 * period is closed when it has only done part of the job.
 */
export const workflowStepKeySchema = z.enum([
  'agent_readiness',
  'customer_and_supplier_invoices',
  'bank_and_tax_account_transactions',
  'accruals_and_depreciations',
  'recurring_journal_entries',
  'completeness_check',
  'general_ledger_review',
  'balance_reconciliations',
  'income_statement_analysis',
  'consolidate_findings',
  'accountant_report',
  'customer_communication_draft',
  'human_review',
  'final_control',
]);
export type WorkflowStepKey = z.infer<typeof workflowStepKeySchema>;

export interface WorkflowStepDefinition {
  readonly key: WorkflowStepKey;
  readonly order: number;
  /** Swedish label - the review app is used by Swedish accounting consultants. */
  readonly labelSv: string;
  readonly labelEn: string;
  readonly description: string;
  /** Implemented end-to-end in phase 1? */
  readonly implemented: boolean;
  /**
   * If true, this step must reach `completed` before a period may be reported
   * as complete. Unimplemented steps with this flag keep the period blocked.
   */
  readonly blocksCompletion: boolean;
  readonly dependsOn: readonly WorkflowStepKey[];
}

export const WORKFLOW_STEPS: readonly WorkflowStepDefinition[] = [
  {
    key: 'agent_readiness',
    order: 1,
    labelSv: 'Agentberedskap',
    labelEn: 'Agent readiness',
    description:
      'Verifies integration connection, adapter mode, financial year, account plan, voucher series, client policy and rule versions before any analysis runs.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: [],
  },
  {
    key: 'customer_and_supplier_invoices',
    order: 2,
    labelSv: 'Kund- och leverantörsfakturor',
    labelEn: 'Customer and supplier invoices',
    description:
      'Imports and reconciles customer/supplier invoices against the ledger. Phase 1 imports them as source data; automated booking is out of scope.',
    implemented: false,
    blocksCompletion: true,
    dependsOn: ['agent_readiness'],
  },
  {
    key: 'bank_and_tax_account_transactions',
    order: 3,
    labelSv: 'Bank- och skattekontotransaktioner',
    labelEn: 'Bank and tax-account transactions',
    description:
      'Matches bank and tax-account transactions to invoices and vouchers. Blocked in phase 1: no verified public Fortnox API for bank transaction matching.',
    implemented: false,
    blocksCompletion: true,
    dependsOn: ['customer_and_supplier_invoices'],
  },
  {
    key: 'accruals_and_depreciations',
    order: 4,
    labelSv: 'Periodiseringar och avskrivningar',
    labelEn: 'Accruals and depreciations',
    description: 'Creates accrual and depreciation entries for the period.',
    implemented: false,
    blocksCompletion: true,
    dependsOn: ['customer_and_supplier_invoices'],
  },
  {
    key: 'recurring_journal_entries',
    order: 5,
    labelSv: 'Återkommande verifikationer',
    labelEn: 'Recurring journal entries',
    description: 'Books recurring journal entries defined by client rules.',
    implemented: false,
    blocksCompletion: true,
    dependsOn: ['agent_readiness'],
  },
  {
    key: 'completeness_check',
    order: 6,
    labelSv: 'Fullständighetskontroll',
    labelEn: 'Completeness check',
    description:
      'Checks that expected recurring costs exist, that documentation is attached and that nothing was booked into the wrong period.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: ['agent_readiness'],
  },
  {
    key: 'general_ledger_review',
    order: 7,
    labelSv: 'Huvudboksgranskning',
    labelEn: 'General-ledger review',
    description:
      'Runs the deterministic anomaly rules over every voucher row in the period and produces explainable findings.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: ['agent_readiness'],
  },
  {
    key: 'balance_reconciliations',
    order: 8,
    labelSv: 'Balansavstämningar',
    labelEn: 'Balance reconciliations',
    description: 'Reconciles balance sheet accounts against sub-ledgers and external statements.',
    implemented: false,
    blocksCompletion: true,
    dependsOn: ['general_ledger_review'],
  },
  {
    key: 'income_statement_analysis',
    order: 9,
    labelSv: 'Resultatanalys',
    labelEn: 'Income-statement analysis',
    description: 'Analyses the income statement against budget and prior periods.',
    implemented: false,
    blocksCompletion: false,
    dependsOn: ['general_ledger_review'],
  },
  {
    key: 'consolidate_findings',
    order: 10,
    labelSv: 'Konsolidera avvikelser',
    labelEn: 'Consolidate findings',
    description:
      'Deduplicates findings across all checks by deduplication key, merges evidence and keeps the highest severity.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: ['completeness_check', 'general_ledger_review'],
  },
  {
    key: 'accountant_report',
    order: 11,
    labelSv: 'Konsultrapport',
    labelEn: 'Accountant report',
    description: 'Produces the consultant-facing summary of the period, its findings and its blockers.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: ['consolidate_findings'],
  },
  {
    key: 'customer_communication_draft',
    order: 12,
    labelSv: 'Utkast till kundkommunikation',
    labelEn: 'Customer communication draft',
    description:
      'Drafts the client-facing request for missing documentation. Never sends anything in phase 1.',
    implemented: false,
    blocksCompletion: false,
    dependsOn: ['consolidate_findings'],
  },
  {
    key: 'human_review',
    order: 13,
    labelSv: 'Mänsklig granskning',
    labelEn: 'Human review',
    description:
      'The consultant works the review queue. Completes when no finding requiring a consultant is left open.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: ['accountant_report'],
  },
  {
    key: 'final_control',
    order: 14,
    labelSv: 'Slutkontroll',
    labelEn: 'Final control',
    description:
      'Final gate. Verifies that no blocking finding and no blocking unimplemented step remains before a period may be reported complete.',
    implemented: true,
    blocksCompletion: true,
    dependsOn: ['human_review'],
  },
] as const;

export const WORKFLOW_STEP_KEYS: readonly WorkflowStepKey[] = WORKFLOW_STEPS.map((s) => s.key);

const STEP_BY_KEY = new Map<WorkflowStepKey, WorkflowStepDefinition>(
  WORKFLOW_STEPS.map((s) => [s.key, s]),
);

export function getStepDefinition(key: WorkflowStepKey): WorkflowStepDefinition {
  const def = STEP_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown workflow step: ${key}`);
  return def;
}

export function implementedSteps(): readonly WorkflowStepDefinition[] {
  return WORKFLOW_STEPS.filter((s) => s.implemented);
}
