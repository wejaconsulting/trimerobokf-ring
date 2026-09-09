import { createModelProvider } from '@trimeros/agent';
import {
  DEMO_IDS,
  createRepositories,
  openEphemeralDatabase,
  seedDemoData,
  type DbHandle,
  type Repositories,
} from '@trimeros/db';
import { FORTNOX_CONNECTION_KIND } from '@trimeros/domain';
import { MockFortnoxAdapter } from '@trimeros/fortnox';
import { DEMO_PERIOD, buildSyntheticDataset } from '@trimeros/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseWorkflowEngine } from '../src/engine.js';
import { recordReviewDecision } from '../src/review.js';
import type { CloseRunSummary } from '../src/types.js';

/**
 * The vertical slice, end to end, against a real Postgres dialect.
 *
 * PGlite runs the same SQL and the same generated migrations as the Docker
 * Compose database, so this is an integration test rather than a mock of one.
 */
describe('close run (integration)', () => {
  let handle: DbHandle;
  let repos: Repositories;
  let engine: DatabaseWorkflowEngine;
  let closeRunId: string;
  let summary: CloseRunSummary;

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);

    repos = createRepositories(handle.db);
    engine = new DatabaseWorkflowEngine({
      repos,
      fortnox: new MockFortnoxAdapter({ ...buildSyntheticDataset() }),
      model: createModelProvider({ provider: 'fake', model: 'fake', timeoutMs: 5000, maxRetries: 0 }),
      shadowMode: true,
    });

    const started = await engine.startCloseRun({
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      periodKey: DEMO_PERIOD,
    });
    closeRunId = started.closeRunId;
    summary = await engine.executeCloseRun(DEMO_IDS.tenant, closeRunId);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  it('creates all 14 steps and runs the implemented ones', () => {
    expect(summary.steps).toHaveLength(14);
    const byKey = new Map(summary.steps.map((s) => [s.stepKey, s.status]));
    expect(byKey.get('agent_readiness')).toBe('completed');
    expect(byKey.get('completeness_check')).toBe('completed');
    expect(byKey.get('general_ledger_review')).toBe('completed');
    expect(byKey.get('consolidate_findings')).toBe('completed');
    expect(byKey.get('accountant_report')).toBe('completed');
  });

  it('marks the unimplemented steps as not_implemented rather than completed', () => {
    const byKey = new Map(summary.steps.map((s) => [s.stepKey, s.status]));
    for (const key of [
      'customer_and_supplier_invoices',
      'bank_and_tax_account_transactions',
      'accruals_and_depreciations',
      'recurring_journal_entries',
      'balance_reconciliations',
      'income_statement_analysis',
      'customer_communication_draft',
    ] as const) {
      expect(byKey.get(key)).toBe('not_implemented');
    }
  });

  it('refuses to report the period complete while work is outstanding', () => {
    expect(summary.canComplete).toBe(false);
    expect(summary.status).not.toBe('completed');
    expect(summary.reasons.join(' ')).toContain('inte implementerat');
  });

  it('produces findings, blockers and a clear-item count', () => {
    expect(summary.findingCount).toBeGreaterThan(5);
    expect(summary.blockingFindingCount).toBeGreaterThan(0);
    expect(summary.clearItemCount).toBeGreaterThan(0);
    expect(summary.reviewCount + summary.manualCount).toBeGreaterThan(0);
  });

  it('imports the ledger and the normalised transactions', async () => {
    const scope = { tenantId: DEMO_IDS.tenant, clientId: DEMO_IDS.client };
    expect(await repos.countImportedRecordsByKind(scope, DEMO_PERIOD, 'voucher')).toBeGreaterThan(10);
    expect(await repos.countImportedRecords(scope, DEMO_PERIOD)).toBeGreaterThan(10);
  });

  it('persists deduplicated findings, one row per deduplication key', async () => {
    const findings = await repos.listFindings({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    const keys = findings.map((f) => f.deduplicationKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(findings.some((f) => f.mergedFromRuleIds.length > 1)).toBe(true);
  });

  it('queues every finding that needs a consultant for review', async () => {
    const findings = await repos.listFindings({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    const reviewItems = await repos.listReviewItems({ tenantId: DEMO_IDS.tenant }, closeRunId);
    expect(reviewItems).toHaveLength(findings.filter((f) => f.requiresConsultant).length);
  });

  it('stores simulated Fortnox payloads and never a real Fortnox id', async () => {
    const proposals = await repos.listProposals({ tenantId: DEMO_IDS.tenant }, closeRunId);
    expect(proposals.length).toBeGreaterThan(0);

    for (const proposal of proposals) {
      expect(proposal.status).toBe('simulated');
      expect(proposal.simulatedFortnoxEndpoint).toBe('POST /3/vouchers');
      expect(proposal.simulatedPayloadHash).toMatch(/^[0-9a-f]{16}$/);

      const rows = await repos.listProposalRows([proposal.id]);
      const debit = rows.reduce((a, r) => a + r.debit, 0);
      const credit = rows.reduce((a, r) => a + r.credit, 0);
      expect(debit).toBe(credit);
    }

    const audit = await repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    expect(audit.some((e) => e.result === 'simulated')).toBe(true);
    expect(audit.every((e) => e.fortnoxId === null)).toBe(true);
  });

  it('writes an audit trail with the rule, prompt and model versions', async () => {
    const audit = await repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    expect(audit.length).toBeGreaterThan(10);
    expect(audit.some((e) => e.ruleVersion !== null)).toBe(true);

    const modelEvent = audit.find((e) => e.operation === 'agent.model_invoked');
    expect(modelEvent?.promptVersion).toBe('accountant_report@1.0.0');
    expect(modelEvent?.modelProvider).toBe('fake');
    expect(modelEvent?.inputRefs.some((r) => r.startsWith('tokens_in:'))).toBe(true);
  });

  it('keeps no secret anywhere in the audit log', async () => {
    const audit = await repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    const serialised = JSON.stringify(audit).toLowerCase();
    for (const forbidden of ['access_token', 'client_secret', 'authorization', 'api_key']) {
      // The key may appear only as a redaction marker, never with a value.
      const index = serialised.indexOf(`"${forbidden}":`);
      if (index >= 0) expect(serialised.slice(index, index + 80)).toContain('[redacted]');
    }
  });

  it('is idempotent: a second run over the same period does not multiply findings', async () => {
    const before = await repos.listFindings({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    const again = await engine.executeCloseRun(DEMO_IDS.tenant, closeRunId);
    const after = await repos.listFindings({ tenantId: DEMO_IDS.tenant }, { closeRunId });

    expect(after).toHaveLength(before.length);
    expect(again.findingCount).toBe(summary.findingCount);
  }, 60_000);

  it('records a review decision without touching Fortnox', async () => {
    const findings = await repos.listFindings(
      { tenantId: DEMO_IDS.tenant },
      { closeRunId, status: ['open'] },
    );
    const target = findings.find((f) => f.requiresConsultant);
    expect(target).toBeDefined();

    const result = await recordReviewDecision(repos, {
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      findingId: target!.id,
      kind: 'approve',
      decidedByUserId: DEMO_IDS.users.consultant,
      comment: 'Kontrollerat mot underlaget.',
    });

    expect(result.shadowOnly).toBe(true);
    expect(result.findingStatus).toBe('approved');

    const updated = await repos.getFinding({ tenantId: DEMO_IDS.tenant }, target!.id);
    expect(updated?.status).toBe('approved');

    const audit = await repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId });
    expect(audit.every((e) => e.fortnoxId === null)).toBe(true);
  });

  it('creates a draft customer request that is never sent', async () => {
    const findings = await repos.listFindings(
      { tenantId: DEMO_IDS.tenant },
      { closeRunId, status: ['open'] },
    );
    const target = findings.find((f) => f.requiresConsultant);
    expect(target).toBeDefined();

    await recordReviewDecision(repos, {
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      findingId: target!.id,
      kind: 'request_information',
      decidedByUserId: DEMO_IDS.users.consultant,
    });

    const requests = await repos.listCustomerRequests({ tenantId: DEMO_IDS.tenant }, closeRunId);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.sentAt === null && r.status === 'draft')).toBe(true);
  });

  it('isolates tenants: another tenant sees nothing', async () => {
    const other = await repos.listFindings({ tenantId: 'firm-someone-else' }, { closeRunId });
    expect(other).toHaveLength(0);
    expect(await repos.listClients({ tenantId: 'firm-someone-else' })).toHaveLength(0);
    expect(await repos.getCloseRun({ tenantId: 'firm-someone-else' }, closeRunId)).toBeUndefined();
  });
});

/**
 * A live OAuth grant must not change what a close run reads.
 *
 * Both records live in `integration_connections` for the same client, so a
 * lookup that forgets to name its kind gets whichever row the database returns
 * first. This pins the behaviour: connecting a real Fortnox account leaves the
 * run's data source exactly where it was.
 */
describe('a client that has also connected Fortnox over OAuth', () => {
  let handle: DbHandle;
  let repos: Repositories;
  let engine: DatabaseWorkflowEngine;

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);
    repos = createRepositories(handle.db);

    // The row a completed OAuth connection leaves behind.
    await repos.upsertIntegrationConnection({
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      kind: FORTNOX_CONNECTION_KIND,
      mode: 'real_read_only',
      scopes: ['bookkeeping'],
      credentialRef: `fortnox:${DEMO_IDS.tenant}:${DEMO_IDS.client}`,
      status: 'connected',
      healthy: true,
      writesEnabled: false,
    });

    engine = new DatabaseWorkflowEngine({
      repos,
      fortnox: new MockFortnoxAdapter({ ...buildSyntheticDataset() }),
      model: createModelProvider({ provider: 'fake', model: 'fake', timeoutMs: 5000, maxRetries: 0 }),
      shadowMode: true,
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  it('still passes readiness against the mock data source', async () => {
    const started = await engine.startCloseRun({
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      periodKey: DEMO_PERIOD,
    });
    const result = await engine.executeCloseRun(DEMO_IDS.tenant, started.closeRunId);
    const readiness = result.steps.find((step) => step.stepKey === 'agent_readiness');
    expect(readiness?.status).toBe('completed');
  });
});
