import { createModelProvider } from '@trimeros/agent';
import { createRepositories, openEphemeralDatabase, seedDemoData, type DbHandle } from '@trimeros/db';
import { MockFortnoxAdapter, staticResolver } from '@trimeros/fortnox';
import { buildSyntheticDataset } from '@trimeros/testing';
import { DatabaseWorkflowEngine } from '@trimeros/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFortnoxIntegration } from '../src/integrations/fortnox.js';
import { safeEqual } from '../src/auth.js';
import { FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE, appConfigFromEnv } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';

describe('hosting configuration', () => {
  it('binds loopback locally', () => {
    expect(appConfigFromEnv({}).apiHost).toBe('127.0.0.1');
  });

  it('binds all interfaces when the platform injects PORT', () => {
    const config = appConfigFromEnv({ PORT: '8080' });
    expect(config.apiHost).toBe('0.0.0.0');
    expect(config.apiPort).toBe(8080);
  });

  it('lets an explicit API_HOST win over the heuristic', () => {
    expect(appConfigFromEnv({ PORT: '8080', API_HOST: '127.0.0.1' }).apiHost).toBe('127.0.0.1');
  });

  it('prefers PORT over API_PORT', () => {
    expect(appConfigFromEnv({ PORT: '8080', API_PORT: '4000' }).apiPort).toBe(8080);
    expect(appConfigFromEnv({ API_PORT: '4001' }).apiPort).toBe(4001);
  });

  it('parses a CORS allowlist', () => {
    expect(appConfigFromEnv({ WEB_ORIGIN: 'https://a.example, https://b.example' }).corsOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(appConfigFromEnv({}).corsOrigins).toEqual([]);
  });

  it('keeps the safety switches safe by default and under a typo', () => {
    expect(appConfigFromEnv({}).shadowMode).toBe(true);
    expect(appConfigFromEnv({ SHADOW_MODE: 'yes' }).shadowMode).toBe(false);
    expect(appConfigFromEnv({ SHADOW_MODE: 'TRUE' }).shadowMode).toBe(true);
    // Writes: never one flag. Each missing condition is its own refusal.
    expect(() => appConfigFromEnv({ FORTNOX_WRITES_ENABLED: 'true' })).toThrow(/requires SHADOW_MODE=false/);
    expect(() => appConfigFromEnv({ FORTNOX_WRITES_ENABLED: 'true', SHADOW_MODE: 'false' })).toThrow(
      /FORTNOX_WRITES_ACKNOWLEDGEMENT/,
    );
    expect(() =>
      appConfigFromEnv({
        FORTNOX_WRITES_ENABLED: 'true',
        SHADOW_MODE: 'false',
        FORTNOX_WRITES_ACKNOWLEDGEMENT: FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE,
      }),
    ).toThrow(/meaningless with FORTNOX_ADAPTER=mock/);
    const live = appConfigFromEnv({
      FORTNOX_WRITES_ENABLED: 'true',
      SHADOW_MODE: 'false',
      FORTNOX_WRITES_ACKNOWLEDGEMENT: FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE,
      FORTNOX_ADAPTER: 'auto',
    });
    expect(live.fortnoxWritesEnabled).toBe(true);
    expect(live.shadowMode).toBe(false);
  });

  it('allows real read-only data sources without touching the write switches', () => {
    const config = appConfigFromEnv({ FORTNOX_ADAPTER: 'auto' });
    expect(config.fortnoxAdapter).toBe('auto');
    expect(config.shadowMode).toBe(true);
    expect(config.fortnoxWritesEnabled).toBe(false);
    expect(appConfigFromEnv({ FORTNOX_ADAPTER: 'real' }).fortnoxAdapter).toBe('real');
  });

  it('compares credentials without leaking length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('password gate', () => {
  let handle: DbHandle;
  let gated: FastifyInstance;
  let open: FastifyInstance;

  const makeRuntime = async (extra: Partial<Runtime['config']>): Promise<Runtime> => {
    const repos = createRepositories(handle.db);
    const fortnox = new MockFortnoxAdapter({ ...buildSyntheticDataset() });
    const model = createModelProvider({ provider: 'fake', model: 'fake', timeoutMs: 5000, maxRetries: 0 });
    return {
      config: { ...appConfigFromEnv({}), logLevel: 'silent', ...extra },
      db: handle,
      repos,
      fortnox,
      fortnoxResolver: staticResolver(fortnox),
      fortnoxIntegration: createFortnoxIntegration(appConfigFromEnv({}), repos),
      model,
      engine: new DatabaseWorkflowEngine({ repos, fortnox, model, shadowMode: true }),
      close: async () => {},
    };
  };

  beforeAll(async () => {
    handle = await openEphemeralDatabase();
    await handle.migrate();
    await seedDemoData(handle.db);
    gated = await buildApp(await makeRuntime({ demoUser: 'demo', demoPassword: 'hemligt' }));
    open = await buildApp(await makeRuntime({ demoPassword: '' }));
    await Promise.all([gated.ready(), open.ready()]);
  }, 120_000);

  afterAll(async () => {
    await gated?.close();
    await open?.close();
    await handle?.close();
  });

  const auth = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

  it('refuses an unauthenticated request', async () => {
    const response = await gated.inject({ method: 'GET', url: '/api/clients' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Basic realm');
  });

  it('refuses a wrong password', async () => {
    const response = await gated.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { authorization: auth('demo', 'fel') },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the right credentials', async () => {
    const response = await gated.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { authorization: auth('demo', 'hemligt') },
    });
    expect(response.statusCode).toBe(200);
  });

  it('leaves /health open so platform health checks pass', async () => {
    const response = await gated.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('gates mutating routes too', async () => {
    const response = await gated.inject({
      method: 'POST',
      url: '/api/clients/client-nordvik/close-runs',
      payload: { periodKey: '2025-08' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stays open when no password is configured', async () => {
    const response = await open.inject({ method: 'GET', url: '/api/clients' });
    expect(response.statusCode).toBe(200);
  });
});
