import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Database schema.
 *
 * Tenant isolation: every table carries `tenantId`, every unique constraint is
 * scoped by it, and every query goes through a repository that takes a tenant
 * scope as its first argument. Row-level security is the phase-2 hardening step
 * (see docs/security-and-permissions.md); the column and index design here is
 * what makes it a policy addition rather than a schema migration.
 *
 * Money: every amount is a bigint-safe integer in öre, stored as `numeric` with
 * scale 0 and mapped back to a JS number. SEK amounts in this domain stay far
 * inside Number.MAX_SAFE_INTEGER even in öre.
 */

const id = () => text('id').primaryKey();
const tenant = () => text('tenant_id').notNull();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Integer öre. `numeric(20,0)` keeps Postgres honest about exactness. */
const ore = (name: string) =>
  numeric(name, { precision: 20, scale: 0, mode: 'number' });

export const firms = pgTable('firms', {
  id: id(),
  name: text('name').notNull(),
  organisationNumber: text('organisation_number'),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    tenantId: tenant(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email)],
);

export const clients = pgTable(
  'clients',
  {
    id: id(),
    tenantId: tenant(),
    name: text('name').notNull(),
    organisationNumber: text('organisation_number').notNull(),
    fortnoxCompanyRef: text('fortnox_company_ref'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('clients_tenant_orgnr_uq').on(t.tenantId, t.organisationNumber)],
);

export const clientAccountingPolicies = pgTable(
  'client_accounting_policies',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    materialityThreshold: ore('materiality_threshold').notNull(),
    automationAmountLimit: ore('automation_amount_limit').notNull(),
    costCenterRequiredAccounts: jsonb('cost_center_required_accounts').$type<number[]>().notNull(),
    projectRequiredAccounts: jsonb('project_required_accounts').$type<number[]>().notNull(),
    requireDocumentationForInputVat: boolean('require_documentation_for_input_vat')
      .notNull()
      .default(true),
    historyWindowMonths: integer('history_window_months').notNull().default(12),
    amountDeviationThreshold: real('amount_deviation_threshold').notNull().default(0.5),
    vatRates: jsonb('vat_rates').$type<number[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('policies_tenant_client_uq').on(t.tenantId, t.clientId)],
);

export const clientRules = pgTable(
  'client_rules',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    version: text('version').notNull(),
    active: boolean('active').notNull().default(true),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('client_rules_tenant_client_idx').on(t.tenantId, t.clientId, t.kind)],
);

export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    periodKey: text('period_key').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    status: text('status').notNull(),
    fortnoxLockedThrough: text('fortnox_locked_through'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('periods_tenant_client_period_uq').on(t.tenantId, t.clientId, t.periodKey)],
);

export const closeRuns = pgTable(
  'close_runs',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    periodId: text('period_id').notNull(),
    periodKey: text('period_key').notNull(),
    status: text('status').notNull(),
    shadowMode: boolean('shadow_mode').notNull().default(true),
    ruleSetVersion: text('rule_set_version').notNull(),
    decisionModelVersion: text('decision_model_version').notNull(),
    correlationId: text('correlation_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('close_runs_tenant_client_idx').on(t.tenantId, t.clientId, t.periodKey)],
);

export const closeRunSteps = pgTable(
  'close_run_steps',
  {
    id: id(),
    tenantId: tenant(),
    closeRunId: text('close_run_id').notNull(),
    stepKey: text('step_key').notNull(),
    order: integer('step_order').notNull(),
    status: text('status').notNull(),
    reasonCode: text('reason_code'),
    message: text('message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    attempt: integer('attempt').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [
    uniqueIndex('steps_run_step_uq').on(t.closeRunId, t.stepKey),
    uniqueIndex('steps_idempotency_uq').on(t.tenantId, t.idempotencyKey),
  ],
);

export const sourceDocuments = pgTable(
  'source_documents',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    externalRef: text('external_ref'),
    fileName: text('file_name'),
    received: boolean('received').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('source_documents_tenant_client_idx').on(t.tenantId, t.clientId)],
);

export const importedRecords = pgTable(
  'imported_records',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    closeRunId: text('close_run_id'),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    periodKey: text('period_key'),
    payload: jsonb('payload').notNull(),
    contentHash: text('content_hash').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotent import: re-running an import updates rather than duplicates.
    uniqueIndex('imported_records_uq').on(t.tenantId, t.clientId, t.kind, t.externalId),
    index('imported_records_period_idx').on(t.tenantId, t.clientId, t.periodKey),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    periodKey: text('period_key').notNull(),
    transactionDate: text('transaction_date').notNull(),
    account: integer('account').notNull(),
    debit: ore('debit').notNull(),
    credit: ore('credit').notNull(),
    description: text('description').notNull(),
    costCenter: text('cost_center'),
    project: text('project'),
    vatCode: text('vat_code'),
    voucherId: text('voucher_id').notNull(),
    voucherRowId: text('voucher_row_id').notNull(),
    supplierNumber: text('supplier_number'),
    customerNumber: text('customer_number'),
  },
  (t) => [
    uniqueIndex('transactions_row_uq').on(t.tenantId, t.clientId, t.voucherRowId),
    index('transactions_period_account_idx').on(t.tenantId, t.clientId, t.periodKey, t.account),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    closeRunId: text('close_run_id').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    subject: jsonb('subject').$type<Record<string, unknown>>().notNull(),
    amount: ore('amount').notNull(),
    description: text('description').notNull(),
    rationale: text('rationale').notNull(),
    suggestedAction: text('suggested_action').notNull(),
    evidence: jsonb('evidence').$type<unknown[]>().notNull(),
    decisionLevel: text('decision_level').notNull(),
    decisionScore: real('decision_score').notNull(),
    decisionReasons: jsonb('decision_reasons').$type<string[]>().notNull(),
    requiresConsultant: boolean('requires_consultant').notNull(),
    blocking: boolean('blocking').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    mergedFromRuleIds: jsonb('merged_from_rule_ids').$type<string[]>().notNull(),
    occurrences: integer('occurrences').notNull().default(1),
    status: text('status').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The deduplication guarantee, enforced by the database rather than by hope.
    uniqueIndex('findings_dedup_uq').on(t.tenantId, t.closeRunId, t.deduplicationKey),
    index('findings_queue_idx').on(t.tenantId, t.clientId, t.closeRunId, t.status),
  ],
);

export const bookingProposals = pgTable(
  'booking_proposals',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    closeRunId: text('close_run_id').notNull(),
    findingId: text('finding_id'),
    status: text('status').notNull(),
    decisionLevel: text('decision_level').notNull(),
    decisionScore: real('decision_score').notNull(),
    decisionReasons: jsonb('decision_reasons').$type<string[]>().notNull(),
    transactionDate: text('transaction_date').notNull(),
    series: text('series').notNull(),
    description: text('description').notNull(),
    rationale: text('rationale').notNull(),
    simulatedFortnoxPayload: jsonb('simulated_fortnox_payload').notNull(),
    simulatedFortnoxEndpoint: text('simulated_fortnox_endpoint').notNull(),
    simulatedPayloadHash: text('simulated_payload_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('proposals_run_idx').on(t.tenantId, t.closeRunId)],
);

export const bookingProposalRows = pgTable(
  'booking_proposal_rows',
  {
    id: id(),
    tenantId: tenant(),
    proposalId: text('proposal_id').notNull(),
    account: integer('account').notNull(),
    debit: ore('debit').notNull(),
    credit: ore('credit').notNull(),
    description: text('description').notNull(),
    costCenter: text('cost_center'),
    project: text('project'),
    vatCode: text('vat_code'),
  },
  (t) => [index('proposal_rows_proposal_idx').on(t.proposalId)],
);

export const reconciliations = pgTable(
  'reconciliations',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    closeRunId: text('close_run_id').notNull(),
    account: integer('account').notNull(),
    periodKey: text('period_key').notNull(),
    ledgerBalance: ore('ledger_balance').notNull(),
    externalBalance: ore('external_balance'),
    difference: ore('difference').notNull(),
    status: text('status').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('reconciliations_uq').on(t.tenantId, t.closeRunId, t.account)],
);

export const reconciliationItems = pgTable(
  'reconciliation_items',
  {
    id: id(),
    tenantId: tenant(),
    reconciliationId: text('reconciliation_id').notNull(),
    reference: text('reference').notNull(),
    amount: ore('amount').notNull(),
    matched: boolean('matched').notNull().default(false),
    note: text('note'),
  },
  (t) => [index('reconciliation_items_idx').on(t.reconciliationId)],
);

export const reviewItems = pgTable(
  'review_items',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    closeRunId: text('close_run_id').notNull(),
    findingId: text('finding_id').notNull(),
    status: text('status').notNull(),
    assignedToUserId: text('assigned_to_user_id'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('review_items_finding_uq').on(t.tenantId, t.findingId),
    index('review_items_queue_idx').on(t.tenantId, t.closeRunId, t.status),
  ],
);

export const customerRequests = pgTable(
  'customer_requests',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    closeRunId: text('close_run_id').notNull(),
    findingId: text('finding_id'),
    status: text('status').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('customer_requests_run_idx').on(t.tenantId, t.closeRunId)],
);

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    reviewItemId: text('review_item_id').notNull(),
    findingId: text('finding_id').notNull(),
    proposalId: text('proposal_id'),
    kind: text('kind').notNull(),
    decidedByUserId: text('decided_by_user_id').notNull(),
    comment: text('comment'),
    editedPayload: jsonb('edited_payload'),
    shadowOnly: boolean('shadow_only').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('approval_decisions_finding_idx').on(t.tenantId, t.findingId)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id'),
    closeRunId: text('close_run_id'),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    operation: text('operation').notNull(),
    inputRefs: jsonb('input_refs').$type<string[]>().notNull(),
    ruleVersion: text('rule_version'),
    promptVersion: text('prompt_version'),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    toolCall: text('tool_call'),
    proposedPayload: jsonb('proposed_payload'),
    approvedPayload: jsonb('approved_payload'),
    result: text('result').notNull(),
    fortnoxId: text('fortnox_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    correlationId: text('correlation_id').notNull(),
  },
  (t) => [
    index('audit_events_correlation_idx').on(t.tenantId, t.correlationId),
    index('audit_events_run_idx').on(t.tenantId, t.closeRunId, t.occurredAt),
  ],
);

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    mode: text('mode').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    /**
     * Points at `integration_credentials`. The secret itself is never a column
     * on this table, so the row a UI or an API response is built from carries
     * no credential material at all.
     */
    credentialRef: text('credential_ref'),
    writesEnabled: boolean('writes_enabled').notNull().default(false),
    healthy: boolean('healthy').notNull().default(true),
    /** disconnected | connected | needs_reconnect */
    status: text('status').notNull().default('disconnected'),
    /** A short machine code (e.g. `invalid_grant`), never free-text detail. */
    statusCode: text('status_code'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    connectedByUserId: text('connected_by_user_id'),
    /** Echoed back from the connection test, so the UI can name the company. */
    remoteCompanyName: text('remote_company_name'),
    remoteOrganisationNumber: text('remote_organisation_number'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('integration_connections_uq').on(t.tenantId, t.clientId, t.kind)],
);

/**
 * Sealed OAuth credentials.
 *
 * Separate from `integration_connections` so that reading connection status -
 * which the UI and the API do constantly - never loads a credential into
 * memory. Every value here is AES-256-GCM ciphertext bound to its own
 * tenant/client/kind; see packages/fortnox/src/oauth/crypto.ts.
 */
export const integrationCredentials = pgTable(
  'integration_credentials',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    kind: text('kind').notNull(),
    sealedAccessToken: text('sealed_access_token'),
    sealedRefreshToken: text('sealed_refresh_token').notNull(),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    /**
     * Fortnox refresh tokens expire 45 days after issue. Recording it lets the
     * console warn before a connection dies rather than after.
     */
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    grantedScopes: jsonb('granted_scopes').$type<string[]>().notNull(),
    /** Keyed HMAC prefix. Distinguishes rotations in the audit trail. */
    refreshTokenFingerprint: text('refresh_token_fingerprint').notNull(),
    /**
     * Incremented on every rotation. The refresh write is conditional on the
     * value it read, so two concurrent refreshes cannot both persist a token.
     */
    rotationCount: integer('rotation_count').notNull().default(0),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('integration_credentials_uq').on(t.tenantId, t.clientId, t.kind)],
);

/**
 * In-flight OAuth authorization requests.
 *
 * The `state` value is stored only as a hash, expires with Fortnox's ten-minute
 * authorization code, and is consumed on first use. That combination is what
 * makes the callback safe to expose without the console's own password gate:
 * the parameter it carries is a single-use, server-issued, unguessable secret.
 */
export const oauthAuthorizationRequests = pgTable(
  'oauth_authorization_requests',
  {
    id: id(),
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    provider: text('provider').notNull(),
    stateHash: text('state_hash').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    requestedScopes: jsonb('requested_scopes').$type<string[]>().notNull(),
    initiatedByUserId: text('initiated_by_user_id').notNull(),
    /** Where to send the browser once the exchange finishes. */
    returnTo: text('return_to'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('oauth_authorization_requests_state_uq').on(t.stateHash),
    index('oauth_authorization_requests_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Source keys already booked by a completed run.
 *
 * This is what makes "the same source record cannot be booked twice" and
 * "the same workflow action is idempotent" hold across runs rather than only
 * inside one.
 */
export const processedSourceRecords = pgTable(
  'processed_source_records',
  {
    tenantId: tenant(),
    clientId: text('client_id').notNull(),
    sourceKey: text('source_key').notNull(),
    closeRunId: text('close_run_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.clientId, t.sourceKey] })],
);

export const closeRunRelations = relations(closeRuns, ({ many }) => ({
  steps: many(closeRunSteps),
  findings: many(findings),
  proposals: many(bookingProposals),
}));

export const findingRelations = relations(findings, ({ many }) => ({
  proposals: many(bookingProposals),
  reviewItems: many(reviewItems),
}));

export const proposalRelations = relations(bookingProposals, ({ many }) => ({
  rows: many(bookingProposalRows),
}));
