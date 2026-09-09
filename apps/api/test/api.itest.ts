import { createModelProvider } from '@trimeros/agent';
import {
  DEMO_IDS,
  createRepositories,
  openEphemeralDatabase,
  seedDemoData,
  type DbHandle,
} from '@trimeros/db';
import { MockFortnoxAdapter, staticResolver } from '@trimeros/fortnox';
import { DEMO_PERIOD, buildSyntheticDataset } from '@trimeros/testing';
import { DatabaseWorkflowEngine } from '@trimeros/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFortnoxIntegration } from '../src/integrations/fortnox.js';
import { appConfigFromEnv } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';

/** Exercises the HTTP surface the review app depends on. */
describe('API (integration)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let runtime: Runtime;
  let closeRunId: string;

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);

    const repos = createRepositories(handle.db);
    const fortnox = new MockFortnoxAdapter({ ...buildSyntheticDataset() });
    const model = createModelProvider({ provider: 'fake', model: 'fake', timeoutMs: 5000, maxRetries: 0 });

    runtime = {
      config: { ...appConfigFromEnv({}), logLevel: 'silent' },
      db: handle,
      repos,
      fortnox,
      fortnoxResolver: staticResolver(fortnox),
      fortnoxIntegration: createFortnoxIntegration(appConfigFromEnv({}), repos),
      model,
      engine: new DatabaseWorkflowEngine({ repos, fortnox, model, shadowMode: true }),
      close: () => handle.close(),
    };

    app = await buildApp(runtime);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  const headers = { 'x-tenant-id': DEMO_IDS.tenant };

  it('reports healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('discloses shadow mode and the unverified Fortnox capabilities', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/status', headers });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.shadowMode).toBe(true);
    expect(body.fortnoxWritesEnabled).toBe(false);
    expect(body.fortnoxAdapter).toBe('mock');
    expect(Object.keys(body.unverifiedCapabilities)).toContain('bank_transactions');
  });

  it('starts and executes a close run', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/clients/${DEMO_IDS.client}/close-runs`,
      headers,
      payload: { periodKey: DEMO_PERIOD },
    });
    expect(response.statusCode).toBe(201);
    const summary = response.json();
    closeRunId = summary.closeRunId;
    expect(summary.steps).toHaveLength(14);
    expect(summary.canComplete).toBe(false);
  }, 60_000);

  it('rejects an invalid period key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/clients/${DEMO_IDS.client}/close-runs`,
      headers,
      payload: { periodKey: 'August' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_error');
  });

  it('lists clients with the counters the overview needs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/clients', headers });
    const [entry] = response.json();
    expect(entry.client.name).toBe('Nordvik Konsult AB');
    expect(entry.summary.totalSteps).toBe(14);
    expect(entry.summary.completedSteps).toBeGreaterThan(0);
    expect(entry.summary.missingDocumentationCount).toBeGreaterThan(0);
  });

  it('returns the run with all 14 labelled steps', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/close-runs/${closeRunId}`, headers });
    const body = response.json();
    expect(body.steps).toHaveLength(14);
    expect(body.steps[0].labelSv).toBe('Agentberedskap');
    expect(body.steps.some((s: { implemented: boolean }) => !s.implemented)).toBe(true);
  });

  it('404s an unknown run', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/close-runs/nope', headers });
    expect(response.statusCode).toBe(404);
  });

  it('filters the review queue', async () => {
    const all = await app.inject({ method: 'GET', url: `/api/close-runs/${closeRunId}/findings`, headers });
    const blocking = await app.inject({
      method: 'GET',
      url: `/api/close-runs/${closeRunId}/findings?blocking=true`,
      headers,
    });
    const expensive = await app.inject({
      method: 'GET',
      url: `/api/close-runs/${closeRunId}/findings?minAmount=1000000`,
      headers,
    });

    expect(all.json().length).toBeGreaterThan(blocking.json().length);
    expect(blocking.json().every((f: { blocking: boolean }) => f.blocking)).toBe(true);
    expect(expensive.json().every((f: { amount: number }) => f.amount >= 1_000_000)).toBe(true);
  });

  it('returns a finding with its rules, proposal and simulated payload', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/close-runs/${closeRunId}/findings`,
      headers,
    });
    const withProposal = list.json().find((f: { hasProposal: boolean }) => f.hasProposal);
    expect(withProposal).toBeDefined();

    const response = await app.inject({
      method: 'GET',
      url: `/api/findings/${withProposal.id}`,
      headers,
    });
    const body = response.json();
    expect(body.matchedRules.length).toBeGreaterThan(0);
    expect(body.proposals[0].simulatedFortnoxEndpoint).toBe('POST /3/vouchers');
    expect(body.proposals[0].simulatedFortnoxPayload.Voucher.VoucherRows.length).toBeGreaterThan(0);
    expect(body.auditHistory.length).toBeGreaterThan(0);
  });

  it('records an approval as internal state only', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/close-runs/${closeRunId}/findings?status=open`,
      headers,
    });
    const target = list.json().find((f: { requiresConsultant: boolean }) => f.requiresConsultant);

    const response = await app.inject({
      method: 'POST',
      url: `/api/findings/${target.id}/decision`,
      headers,
      payload: { kind: 'approve', decidedByUserId: DEMO_IDS.users.consultant },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.shadowOnly).toBe(true);
    expect(body.note).toContain('Ingenting har skickats till Fortnox');

    const after = await app.inject({ method: 'GET', url: `/api/findings/${target.id}`, headers });
    expect(after.json().finding.status).toBe('approved');
  });

  it('never exposes a Fortnox id, because nothing was ever written', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/close-runs/${closeRunId}/audit`, headers });
    const events = response.json();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e: { fortnoxId: string | null }) => e.fortnoxId === null)).toBe(true);
  });

  it('isolates tenants at the HTTP boundary', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { 'x-tenant-id': 'firm-someone-else' },
    });
    expect(response.json()).toEqual([]);

    const run = await app.inject({
      method: 'GET',
      url: `/api/close-runs/${closeRunId}`,
      headers: { 'x-tenant-id': 'firm-someone-else' },
    });
    expect(run.statusCode).toBe(404);
  });
});
