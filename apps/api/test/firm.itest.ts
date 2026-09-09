import { createModelProvider } from '@trimeros/agent';
import { DEMO_IDS, createRepositories, openEphemeralDatabase, seedDemoData, type DbHandle } from '@trimeros/db';
import { FORTNOX_CONNECTION_KIND } from '@trimeros/domain';
import { MockFortnoxAdapter, generateEncryptionKey, staticResolver } from '@trimeros/fortnox';
import { DEMO_PERIOD, buildSyntheticDataset } from '@trimeros/testing';
import { DatabaseWorkflowEngine } from '@trimeros/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { appConfigFromEnv } from '../src/config.js';
import { createFortnoxIntegration, createFortnoxResolver } from '../src/integrations/fortnox.js';
import type { Runtime } from '../src/runtime.js';

/** Firm-level routes and the per-client data-source resolver. */
describe('firm operations (integration)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let runtime: Runtime;
  const headers = { 'x-tenant-id': DEMO_IDS.tenant };

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);

    const repos = createRepositories(handle.db);
    const fortnox = new MockFortnoxAdapter({ ...buildSyntheticDataset() });
    const model = createModelProvider({ provider: 'fake', model: 'fake', timeoutMs: 5000, maxRetries: 0 });
    const config = { ...appConfigFromEnv({}), logLevel: 'silent' };
    runtime = {
      config,
      db: handle,
      repos,
      fortnox,
      fortnoxResolver: staticResolver(fortnox),
      fortnoxIntegration: createFortnoxIntegration(config, repos),
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

  let newClientId = '';

  it('adds a client with a default policy and audits it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers,
      payload: { name: 'Solsidan Kafé AB', organisationNumber: '5591234567', userId: DEMO_IDS.users.consultant },
    });
    expect(response.statusCode).toBe(201);
    const { client } = response.json() as { client: { id: string; organisationNumber: string } };
    expect(client.organisationNumber).toBe('559123-4567');
    newClientId = client.id;

    const policy = await app.inject({ method: 'GET', url: `/api/clients/${client.id}/policy`, headers });
    expect(policy.statusCode).toBe(200);
    expect((policy.json() as { policy: { autoBookEnabled: boolean } }).policy.autoBookEnabled).toBe(false);

    const audit = await runtime.repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { correlationId: `client-create-${client.id}` });
    expect(audit.some((e) => e.operation === 'client.created')).toBe(true);
  });

  it('rejects a malformed organisation number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers,
      payload: { name: 'Fel AB', organisationNumber: '12' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('edits the policy and records which fields changed', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${DEMO_IDS.client}/policy`,
      headers,
      payload: { autoBookEnabled: true, automationAmountLimit: 5_000_000, userId: DEMO_IDS.users.consultant },
    });
    expect(response.statusCode).toBe(200);
    const { policy } = response.json() as { policy: { autoBookEnabled: boolean; automationAmountLimit: number } };
    expect(policy.autoBookEnabled).toBe(true);
    expect(policy.automationAmountLimit).toBe(5_000_000);

    const audit = await runtime.repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, {});
    const event = audit.find((e) => e.operation === 'policy.updated');
    expect(event?.inputRefs).toContain('autoBookEnabled:true');
  });

  it('runs a period for every client and reports per client', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/close-runs/run-all',
      headers,
      payload: { periodKey: DEMO_PERIOD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: { clientId: string; status: string; closeRunId: string | null; findingCount: number }[] };
    expect(body.results.map((r) => r.clientId).sort()).toEqual([DEMO_IDS.client, newClientId].sort());

    const demo = body.results.find((r) => r.clientId === DEMO_IDS.client);
    expect(demo?.closeRunId).toBeTruthy();
    expect(demo?.findingCount).toBeGreaterThan(0);
    // The new client ran too - on the shared mock in this test runtime.
    expect(body.results.find((r) => r.clientId === newClientId)?.closeRunId).toBeTruthy();
  });

  it('summarises the firm: automation rate and data sources', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/firm/overview', headers });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      clientCount: number;
      automationRate: number;
      items: { total: number };
      shadowMode: boolean;
      liveBooking: boolean;
      proposals: { approved: number; submitted: number };
    };
    expect(body.clientCount).toBe(2);
    expect(body.items.total).toBeGreaterThan(0);
    expect(body.automationRate).toBeGreaterThan(0);
    expect(body.automationRate).toBeLessThanOrEqual(1);
    expect(body.shadowMode).toBe(true);
    expect(body.liveBooking).toBe(false);
    // autoBookEnabled was switched on above, so the demo run approved some itself.
    expect(body.proposals.approved).toBeGreaterThan(0);
    expect(body.proposals.submitted).toBe(0);
  });

  it('reports every approved proposal as blocked when asked to submit in shadow mode', async () => {
    const [run] = await runtime.repos.listCloseRuns({ tenantId: DEMO_IDS.tenant }, DEMO_IDS.client);
    const response = await app.inject({ method: 'POST', url: `/api/close-runs/${run?.id}/submit`, headers, payload: {} });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { submitted: unknown[]; blocked: { reasons: string[] }[]; liveBooking: boolean };
    expect(body.liveBooking).toBe(false);
    expect(body.submitted).toEqual([]);
    expect(body.blocked.length).toBeGreaterThan(0);
    expect(body.blocked[0]?.reasons).toContain('shadow_mode_active');
  });

  it('refuses to enable per-client writes while shadow mode is on', async () => {
    await runtime.repos.upsertIntegrationConnection({
      tenantId: DEMO_IDS.tenant,
      clientId: DEMO_IDS.client,
      kind: FORTNOX_CONNECTION_KIND,
      mode: 'real_read_only',
      scopes: ['bookkeeping'],
      credentialRef: null,
      status: 'connected',
      healthy: true,
      writesEnabled: false,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/fortnox/writes',
      headers,
      payload: { clientId: DEMO_IDS.client, enabled: true },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe('shadow_mode_active');
  });
});

describe('data-source resolver', () => {
  let handle: DbHandle;
  const env = {
    FORTNOX_CLIENT_ID: 'client-id',
    FORTNOX_CLIENT_SECRET: 'client-secret',
    FORTNOX_TOKEN_ENCRYPTION_KEY: generateEncryptionKey(),
    API_PUBLIC_URL: 'https://api.example.test',
  };

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  function resolverFor(adapter: 'mock' | 'auto' | 'real') {
    const repos = createRepositories(handle.db);
    const config = appConfigFromEnv({ ...env, FORTNOX_ADAPTER: adapter });
    const mock = new MockFortnoxAdapter({ ...buildSyntheticDataset() });
    return { repos, resolver: createFortnoxResolver({ config, repos, integration: createFortnoxIntegration(config, repos), mock }) };
  }
  const scope = { tenantId: DEMO_IDS.tenant, clientId: DEMO_IDS.client };

  it('serves demo data under mock, and refuses under real, for a client without a grant', async () => {
    expect((await resolverFor('mock').resolver.resolve(scope)).kind).toBe('mock');
    expect((await resolverFor('auto').resolver.resolve(scope)).kind).toBe('mock');
    const real = await resolverFor('real').resolver.resolve(scope);
    expect(real.kind).toBe('none');
    expect(real.reason).toContain('inte ansluten');
  });

  it('prefers a connected grant under auto and real, read-only while shadow mode is on', async () => {
    const { repos } = resolverFor('auto');
    await repos.upsertIntegrationConnection({
      ...scope,
      kind: FORTNOX_CONNECTION_KIND,
      mode: 'real_read_only',
      scopes: ['bookkeeping'],
      credentialRef: null,
      status: 'connected',
      healthy: true,
      writesEnabled: true,
      remoteCompanyName: 'Nordvik Bygg AB',
    });
    for (const adapter of ['auto', 'real'] as const) {
      const source = await resolverFor(adapter).resolver.resolve(scope);
      expect(source.kind).toBe('real');
      expect(source.label).toContain('Nordvik');
      expect((await source.port.capabilities()).writesEnabled).toBe(false);
    }
    expect((await resolverFor('mock').resolver.resolve(scope)).kind).toBe('mock');
  });

  it('falls back to none when the grant needs a reconnect', async () => {
    const { repos } = resolverFor('real');
    await repos.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, { status: 'needs_reconnect' });
    expect((await resolverFor('real').resolver.resolve(scope)).kind).toBe('none');
    expect((await resolverFor('auto').resolver.resolve(scope)).kind).toBe('mock');
  });
});
