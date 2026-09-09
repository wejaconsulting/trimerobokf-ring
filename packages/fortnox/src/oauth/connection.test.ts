import { asHttpFetch } from '@trimeros/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FORTNOX_CONNECTION_KIND } from '@trimeros/domain';
import { FortnoxConnectionError, FortnoxConnectionService } from './connection.js';
import { generateEncryptionKey, loadEncryptionKey, sealSecret } from './crypto.js';
import { InMemoryConnectionStore } from './memory-store.js';
import { FortnoxTokenClient } from './token-client.js';

const SCOPE = { tenantId: 'firm-trimeros', clientId: 'client-1' };
const KEY = loadEncryptionKey(generateEncryptionKey());

/** Seals a token exactly the way the service seals an access token. */
function sealFor(token: string): string {
  return sealSecret(KEY, token, { ...SCOPE, kind: 'access_token' });
}

function tokenBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'companyinformation bookkeeping',
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const COMPANY = {
  CompanyInformation: { CompanyName: 'Nordvik Bygg AB', OrganizationNumber: '556677-8899' },
};

/** A fetch stand-in that routes token calls and API calls separately. */
function makeFetch(handlers: {
  token?: () => Response | Promise<Response>;
  api?: () => Response | Promise<Response>;
  revoke?: () => Response | Promise<Response>;
}) {
  return vi.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes('/oauth-v1/revoke')) return (handlers.revoke ?? (() => json({})))();
    if (href.includes('/oauth-v1/token')) return (handlers.token ?? (() => json(tokenBody())))();
    return (handlers.api ?? (() => json(COMPANY)))();
  });
}

interface Harness {
  service: FortnoxConnectionService;
  store: InMemoryConnectionStore;
  fetchImpl: ReturnType<typeof makeFetch>;
  clock: { now: Date };
}

function harness(handlers: Parameters<typeof makeFetch>[0] = {}): Harness {
  const store = new InMemoryConnectionStore();
  const fetchImpl = makeFetch(handlers);
  const clock = { now: new Date('2026-09-07T12:00:00Z') };
  const service = new FortnoxConnectionService({
    store,
    tokenClient: new FortnoxTokenClient({
      clientId: 'app-id',
      clientSecret: 'app-secret',
      fetchImpl: asHttpFetch(fetchImpl),
    }),
    encryptionKey: KEY,
    clientId: 'app-id',
    fetchImpl: asHttpFetch(fetchImpl),
    now: () => clock.now,
  });
  return { service, store, fetchImpl, clock };
}

const REDIRECT = 'https://api.example.com/api/integrations/fortnox/callback';

async function connect(h: Harness): Promise<string> {
  const { authorizeUrl } = await h.service.beginAuthorization({
    ...SCOPE,
    initiatedByUserId: 'user-marcus',
    redirectUri: REDIRECT,
    returnTo: '/installningar/fortnox',
  });
  return new URL(authorizeUrl).searchParams.get('state') ?? '';
}

describe('beginAuthorization', () => {
  it('stores only a hash of the state', async () => {
    const h = harness();
    const state = await connect(h);
    const stored = [...h.store.requests.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.stateHash).not.toBe(state);
    expect(stored[0]!.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.initiatedByUserId).toBe('user-marcus');
  });

  it('expires the request with the ten-minute authorization code', async () => {
    const h = harness();
    await connect(h);
    const row = [...h.store.requests.values()][0]!;
    expect(row.expiresAt.getTime() - h.clock.now.getTime()).toBe(10 * 60 * 1000);
  });

  it('sweeps expired requests as it goes', async () => {
    const h = harness();
    await connect(h);
    h.clock.now = new Date('2026-09-07T12:20:00Z');
    await connect(h);
    expect(h.store.requests.size).toBe(1);
  });
});

describe('completeAuthorization', () => {
  it('stores a sealed credential and reports the company name', async () => {
    const h = harness();
    const state = await connect(h);
    const result = await h.service.completeAuthorization({ state, code: 'auth-code' });

    expect(result.summary.status).toBe('connected');
    expect(result.summary.companyName).toBe('Nordvik Bygg AB');
    expect(result.summary.organisationNumber).toBe('556677-8899');
    expect(result.returnTo).toBe('/installningar/fortnox');

    const credential = await h.store.getIntegrationCredential(SCOPE, FORTNOX_CONNECTION_KIND);
    expect(credential).toBeDefined();
    expect(credential!.sealedRefreshToken).not.toContain('refresh-1');
    expect(credential!.sealedAccessToken).not.toContain('access-1');
  });

  it('never turns writes on', async () => {
    const h = harness();
    const state = await connect(h);
    const result = await h.service.completeAuthorization({ state, code: 'auth-code' });
    expect(result.summary.writesEnabled).toBe(false);
    const connection = await h.store.getIntegrationConnection(SCOPE, FORTNOX_CONNECTION_KIND);
    expect(connection!.writesEnabled).toBe(false);
    expect(connection!.mode).toBe('real_read_only');
  });

  it('rejects a replayed callback', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'auth-code' });
    await expect(h.service.completeAuthorization({ state, code: 'auth-code' })).rejects.toMatchObject(
      { code: 'invalid_state' },
    );
  });

  it('rejects an expired state without spending the code', async () => {
    const h = harness();
    const state = await connect(h);
    h.clock.now = new Date('2026-09-07T12:11:00Z');
    await expect(h.service.completeAuthorization({ state, code: 'c' })).rejects.toBeInstanceOf(
      FortnoxConnectionError,
    );
    // No token call was made: the state check happens first.
    expect(h.fetchImpl.mock.calls.filter((c) => String(c[0]).includes('token'))).toHaveLength(0);
  });

  it('rejects an unknown state', async () => {
    const h = harness();
    await expect(
      h.service.completeAuthorization({ state: 'never-issued', code: 'c' }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('reports a connection whose verification call failed, without claiming it works', async () => {
    const h = harness({ api: () => json({ message: 'not found' }, 404) });
    const state = await connect(h);
    const result = await h.service.completeAuthorization({ state, code: 'auth-code' });
    // The token is real, so the connection stands - but nothing is claimed about it.
    expect(result.summary.status).toBe('connected');
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.statusCode).toBe('company_check_http_404');
    expect(result.summary.companyName).toBeNull();
  });

  it('marks a 401 on verification as needing a reconnect', async () => {
    const h = harness({ api: () => json({ message: 'unauthorized' }, 401) });
    const state = await connect(h);
    const result = await h.service.completeAuthorization({ state, code: 'auth-code' });
    expect(result.summary.status).toBe('needs_reconnect');
  });
});

describe('getAccessToken', () => {
  it('refuses when the client was never connected', async () => {
    const h = harness();
    await expect(h.service.getAccessToken(SCOPE)).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('reuses a token that is still valid', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });
    const before = h.fetchImpl.mock.calls.length;

    await expect(h.service.getAccessToken(SCOPE)).resolves.toBe('access-1');
    expect(h.fetchImpl.mock.calls.length).toBe(before);
  });

  it('refreshes before the token actually expires', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });

    // 30s before expiry: inside the skew window, so it must refresh.
    h.clock.now = new Date(h.clock.now.getTime() + (3600 - 30) * 1000);
    h.fetchImpl.mockImplementation(async (url: unknown) =>
      String(url).includes('token')
        ? json(tokenBody({ access_token: 'access-2', refresh_token: 'refresh-2' }))
        : json(COMPANY),
    );

    await expect(h.service.getAccessToken(SCOPE)).resolves.toBe('access-2');
    const credential = await h.store.getIntegrationCredential(SCOPE, FORTNOX_CONNECTION_KIND);
    expect(credential!.rotationCount).toBe(1);
  });

  it('refreshes once for concurrent callers, because the token rotates', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });
    h.clock.now = new Date(h.clock.now.getTime() + 3601 * 1000);

    let tokenCalls = 0;
    h.fetchImpl.mockImplementation(async (url: unknown) => {
      if (!String(url).includes('token')) return json(COMPANY);
      tokenCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return json(tokenBody({ access_token: 'access-2', refresh_token: 'refresh-2' }));
    });

    const results = await Promise.all([
      h.service.getAccessToken(SCOPE),
      h.service.getAccessToken(SCOPE),
      h.service.getAccessToken(SCOPE),
    ]);
    expect(tokenCalls).toBe(1);
    expect(results).toEqual(['access-2', 'access-2', 'access-2']);
  });

  it('deletes the dead credential when the grant is gone', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });
    h.clock.now = new Date(h.clock.now.getTime() + 3601 * 1000);

    h.fetchImpl.mockImplementation(async (url: unknown) =>
      String(url).includes('token')
        ? json({ error: 'invalid_grant', error_description: 'expired' }, 400)
        : json(COMPANY),
    );

    await expect(h.service.getAccessToken(SCOPE)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await h.store.getIntegrationCredential(SCOPE, FORTNOX_CONNECTION_KIND)).toBeUndefined();

    const summary = await h.service.getStatus(SCOPE);
    expect(summary.status).toBe('needs_reconnect');
    expect(summary.statusCode).toBe('invalid_grant');
  });

  it('keeps the credential when the failure is transient', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });
    h.clock.now = new Date(h.clock.now.getTime() + 3601 * 1000);

    h.fetchImpl.mockImplementation(async (url: unknown) =>
      String(url).includes('token') ? json({ error: 'temporarily_unavailable' }, 503) : json(COMPANY),
    );

    await expect(h.service.getAccessToken(SCOPE)).rejects.toBeDefined();
    expect(await h.store.getIntegrationCredential(SCOPE, FORTNOX_CONNECTION_KIND)).toBeDefined();
  });

  it('yields to the winner when a rotation loses the compare-and-set', async () => {
    const h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });
    h.clock.now = new Date(h.clock.now.getTime() + 3601 * 1000);

    // Simulate another process having already rotated: the CAS will not match.
    const original = h.store.rotateIntegrationCredential.bind(h.store);
    vi.spyOn(h.store, 'rotateIntegrationCredential').mockImplementation(async (scope, kind, _expected, patch) => {
      await original(scope, kind, 0, {
        ...patch,
        sealedAccessToken: sealFor('winner-access'),
      });
      return false;
    });

    h.fetchImpl.mockImplementation(async (url: unknown) =>
      String(url).includes('token')
        ? json(tokenBody({ access_token: 'loser-access', refresh_token: 'refresh-2' }))
        : json(COMPANY),
    );

    await expect(h.service.getAccessToken(SCOPE)).resolves.toBe('winner-access');
  });
});

describe('disconnect', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    const state = await connect(h);
    await h.service.completeAuthorization({ state, code: 'c' });
  });

  it('revokes at Fortnox and deletes the local credential', async () => {
    await expect(h.service.disconnect(SCOPE)).resolves.toEqual({ revokedAtFortnox: true });
    expect(await h.store.getIntegrationCredential(SCOPE, FORTNOX_CONNECTION_KIND)).toBeUndefined();
    const summary = await h.service.getStatus(SCOPE);
    expect(summary.status).toBe('disconnected');
    expect(summary.companyName).toBeNull();
  });

  it('still disconnects locally when revocation fails', async () => {
    h.fetchImpl.mockImplementation(async () => {
      throw new Error('network down');
    });
    await expect(h.service.disconnect(SCOPE)).resolves.toEqual({ revokedAtFortnox: false });
    expect(await h.store.getIntegrationCredential(SCOPE, FORTNOX_CONNECTION_KIND)).toBeUndefined();
  });
});

describe('getStatus', () => {
  it('does not report connected without a credential to back it', async () => {
    const h = harness();
    await h.store.upsertIntegrationConnection({
      tenantId: SCOPE.tenantId,
      clientId: SCOPE.clientId,
      kind: FORTNOX_CONNECTION_KIND,
      mode: 'real_read_only',
      scopes: [],
      status: 'connected',
      healthy: true,
    });
    await expect(h.service.getStatus(SCOPE)).resolves.toMatchObject({ status: 'disconnected' });
  });
});
