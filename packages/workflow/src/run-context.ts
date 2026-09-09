import type { ModelProvider } from '@trimeros/agent';
import type { ClientRow, PolicyRow, Repositories } from '@trimeros/db';
import type { FindingDraft, LedgerSnapshot, PeriodKey, Voucher } from '@trimeros/domain';
import type { FortnoxCapabilityReport, FortnoxDataSource, FortnoxReadPort } from '@trimeros/fortnox';
import type { ProposalDraft, ProposalRule, RuleContext } from '@trimeros/rules';
import type { AuditWriter } from './audit.js';

/**
 * Per-run mutable state.
 *
 * Steps communicate through this object rather than by re-reading the database,
 * so one close run does one import and one history build. Everything durable
 * still lands in Postgres - this is a cache with the lifetime of a single run,
 * not a source of truth.
 */
export interface RunState {
  ledger?: {
    readonly current: LedgerSnapshot;
    readonly historyVouchers: readonly Voucher[];
    readonly allSupplierInvoices: LedgerSnapshot['supplierInvoices'];
    readonly lockedThrough: string | null;
  };
  capabilities?: FortnoxCapabilityReport;
  ruleContext?: RuleContext;
  /** Raw findings accumulated across steps, consolidated in step 10. */
  rawFindings: FindingDraft[];
  consolidatedFindings?: readonly FindingDraft[];
  proposals?: readonly ProposalDraft[];
  /** Vouchers in the period that produced no finding at all. */
  clearItemCount?: number;
  report?: { headline: string; summary: string; blockers: string[] };
}

export interface StepContext {
  readonly tenantId: string;
  readonly clientId: string;
  readonly closeRunId: string;
  readonly periodKey: PeriodKey;
  readonly correlationId: string;
  readonly client: ClientRow;
  readonly policy: PolicyRow;
  readonly proposalRules: readonly ProposalRule[];
  /** The resolved port for this client. Same object as `dataSource.port`. */
  readonly fortnox: FortnoxReadPort;
  /** Where this run reads from: a real account, demo data, or nothing. */
  readonly dataSource: FortnoxDataSource;
  readonly model: ModelProvider;
  readonly repos: Repositories;
  readonly audit: AuditWriter;
  readonly state: RunState;
  readonly shadowMode: boolean;
  /** The FORTNOX_WRITES_ENABLED feature flag. False unless the operator opted in. */
  readonly fortnoxWritesEnabled: boolean;
}
