import { createModelProvider } from '@trimeros/agent';
import {
  createRepositories,
  openEphemeralDatabase,
  seedDemoData,
  type DbHandle,
} from '@trimeros/db';
import {
  FORTNOX_CONNECTION_KIND,
  MockFortnoxAdapter,
  generateEncryptionKey,
} from '@trimeros/fortnox';
import { buildSyntheticDataset } from '@trimeros/testing';
import { DatabaseWorkflowEngine } from '@trimeros/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { appConfigFromEnv } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';

/**
 * The connection flow against a real database and the real routes.
 *
 * Only Fortnox itself is stubbed, at `globalThis.fetch`. Everything else -
 * migrations, the sealed-credential columns, the state table, the password
 * gate - is the code that would run in production.
 */

const TENANT = 'firm-trimeros';
const CLIENT = 'client-nordvik';
const KEY = generateEncryptionKey();

const CONFIGURED_ENV = {
  FORTNOX_CLIENT_ID: 'app-id',
  FORTNOX_CLIENT_SECRET: 'app-secret',
  FORTNOX_TOKEN_ENCRYPTION_KEY: KEY,
  API_PUBLIC_URL: 'https://api.example.com',
  WEB_BASE_URL: 'https://console.example.com',
};

const TOKEN_RESPONSE = {
  access_token: 'access-token-value',
  refresh_token: 'refresh-token-value',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'companyinformation bookkeeping invoice',
};

const COMPANY_RESPONSE = {
  CompanyInformation: { CompanyName: 'Nordvik Bygg AB', OrganizationNumber: '556677-8899' },
};

function stubFortnox(overrides: { token?: () => Response; api?: () => Response } = {}) {
  const impl = vi.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes('/oauth-v1/revoke')) return new Response('{}', { status: 200 });
    if (href.includes('/oauth-v1/token')) {
      return (overrides.token ?? (() => json(TOKEN_RESPONSE)))();
    }
    return (overrides.api ?? (() => json(COMPANY_RESPONSE)))();
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let handle: DbHandle;

async function makeApp(env: Record<string, string>, extra: Partial<Runtime['config']> = {}) {
  const repos = createRepositories(handle.db);
  const fortnox = new MockFortnoxAdapter({ ...buildSyntheticDataset() });
  const model = createModelProvider({
    provider: 'fake',
    model: 'fake',
    timeoutMs: 5000,
    maxRetries: 0,
  });
  const runtime: Runtime = {
    config: { ...appConfigFromEnv(env), logLevel: 'silent', ...extra },
    db: handle,
    repos,
    fortnox,
    model,
    engine: new DatabaseWorkflowEngine({ repos, fortnox, model, shadowMode: true }),
    close: async () => {},
  };
  const app = await buildApp(runtime);
  await app.ready();
  return { app, repos };
}

/** Pulls the `state` back out of the URL the connect route hands over. */
function stateFrom(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get('state') ?? '';
}

beforeAll(async () => {
  handle = await openEphemeralDatabase();
  await handle.migrate();
  await seedDemoData(handle.db);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('when the integration is not configured', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp({}));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('names the missing settings instead of offering a broken button', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/status?clientId=${CLIENT}`,
      headers: { 'x-tenant-id': TENANT },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.configured).toBe(false);
    expect(body.missing).toEqual([
      'FORTNOX_CLIENT_ID',
      'FORTNOX_CLIENT_SECRET',
      'FORTNOX_TOKEN_ENCRYPTION_KEY',
      'API_PUBLIC_URL',
    ]);
    expect(body.connection).toBeNull();
  });

  it('refuses to start a connection', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/fortnox/connect',
      headers: { 'x-tenant-id': TENANT },
      payload: { clientId: CLIENT, userId: 'user-marcus' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('fortnox_not_configured');
  });
});

describe('the connection flow', () => {
  let app: FastifyInstance;
  let repos: ReturnType<typeof createRepositories>;

  beforeAll(async () => {
    ({ app, repos } = await makeApp(CONFIGURED_ENV));
  });
  afterAll(async () => {
    await app?.close();
  });

  const connect = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/fortnox/connect',
      headers: { 'x-tenant-id': TENANT },
      payload: { clientId: CLIENT, userId: 'user-marcus', returnTo: '/installningar/fortnox' },
    });
    return response.json().authorizeUrl as string;
  };

  it('reports the redirect URI that must be registered at Fortnox', async () => {
    stubFortnox();
    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/status?clientId=${CLIENT}`,
      headers: { 'x-tenant-id': TENANT },
    });
    const body = response.json();
    expect(body.configured).toBe(true);
    expect(body.redirectUri).toBe('https://api.example.com/api/integrations/fortnox/callback');
    expect(body.connection.status).toBe('disconnected');
  });

  it('hands back an authorize URL asking only for read scopes', async () => {
    stubFortnox();
    const url = new URL(await connect());
    expect(url.origin + url.pathname).toBe('https://apps.fortnox.se/oauth-v1/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/integrations/fortnox/callback',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('bookkeeping');
    for (const scope of scopes) expect(scope).not.toMatch(/write/i);
  });

  it('completes the callback and stores only sealed tokens', async () => {
    stubFortnox();
    const state = stateFrom(await connect());

    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      'https://console.example.com/installningar/fortnox?status=connected',
    );

    const credential = await repos.getIntegrationCredential(
      { tenantId: TENANT, clientId: CLIENT },
      FORTNOX_CONNECTION_KIND,
    );
    expect(credential).toBeDefined();
    expect(credential!.sealedRefreshToken).not.toContain('refresh-token-value');
    expect(credential!.sealedAccessToken).not.toContain('access-token-value');
    expect(credential!.refreshTokenFingerprint).toHaveLength(12);

    const connection = await repos.getIntegrationConnection(
      { tenantId: TENANT, clientId: CLIENT },
      FORTNOX_CONNECTION_KIND,
    );
    expect(connection!.status).toBe('connected');
    expect(connection!.writesEnabled).toBe(false);
    expect(connection!.remoteCompanyName).toBe('Nordvik Bygg AB');
  });

  it('never puts a token in a status response', async () => {
    stubFortnox();
    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/status?clientId=${CLIENT}`,
      headers: { 'x-tenant-id': TENANT },
    });
    const raw = response.body;
    expect(raw).not.toContain('access-token-value');
    expect(raw).not.toContain('refresh-token-value');
    expect(raw).not.toContain('app-secret');
    expect(response.json().connection.companyName).toBe('Nordvik Bygg AB');
  });

  it('records the connection in the audit trail without the credential', async () => {
    const events = await repos.listAuditEvents({ tenantId: TENANT }, {});
    const connected = events.filter((e) => e.operation === 'fortnox.oauth.connected');
    expect(connected.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(connected);
    expect(serialised).not.toContain('refresh-token-value');
    expect(serialised).not.toContain('access-token-value');
  });

  it('rejects a replayed callback', async () => {
    stubFortnox();
    const state = stateFrom(await connect());
    await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/callback?code=c&state=${encodeURIComponent(state)}`,
    });
    const replay = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/callback?code=c&state=${encodeURIComponent(state)}`,
    });
    expect(replay.headers.location).toContain('status=error');
    expect(replay.headers.location).toContain('code=invalid_state');
  });

  it('passes a refused consent back to the console', async () => {
    stubFortnox();
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/fortnox/callback?error=access_denied',
    });
    expect(response.headers.location).toBe(
      'https://console.example.com/installningar/fortnox?status=error&code=access_denied',
    );
  });

  it('disconnects and leaves no credential behind', async () => {
    stubFortnox();
    const state = stateFrom(await connect());
    await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/callback?code=c&state=${encodeURIComponent(state)}`,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/fortnox/disconnect',
      headers: { 'x-tenant-id': TENANT },
      payload: { clientId: CLIENT, userId: 'user-marcus' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().connection.status).toBe('disconnected');
    expect(
      await repos.getIntegrationCredential(
        { tenantId: TENANT, clientId: CLIENT },
        FORTNOX_CONNECTION_KIND,
      ),
    ).toBeUndefined();
  });
});

describe('a connection whose verification call fails', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp(CONFIGURED_ENV));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('says so rather than reporting a working connection', async () => {
    stubFortnox({ api: () => json({ message: 'nope' }, 404) });
    const connectResponse = await app.inject({
      method: 'POST',
      url: '/api/integrations/fortnox/connect',
      headers: { 'x-tenant-id': TENANT },
      payload: { clientId: 'client-verify', userId: 'user-marcus' },
    });
    const state = stateFrom(connectResponse.json().authorizeUrl);

    const callback = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/callback?code=c&state=${encodeURIComponent(state)}`,
    });
    expect(callback.headers.location).toContain('status=connected_unverified');
    expect(callback.headers.location).toContain('code=company_check_http_404');
  });
});

describe('the password gate', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await makeApp(CONFIGURED_ENV, { demoUser: 'demo', demoPassword: 'hemligt' }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('still covers the connection routes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/integrations/fortnox/status?clientId=${CLIENT}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('leaves the OAuth callback open, because it carries its own single-use secret', async () => {
    stubFortnox();
    const response = await app.inject({
      method: 'GET',
      url: '/api/integrations/fortnox/callback?error=access_denied',
    });
    expect(response.statusCode).toBe(302);
  });
});
