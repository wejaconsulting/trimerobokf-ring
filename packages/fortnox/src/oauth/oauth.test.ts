import { asHttpFetch } from '@trimeros/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  generateState,
  hashState,
  stateMatches,
} from './authorize.js';
import {
  EncryptionKeyError,
  SealedSecretError,
  generateEncryptionKey,
  loadEncryptionKey,
  openSecret,
  sealSecret,
  secretFingerprint,
} from './crypto.js';
import { FORTNOX_READ_SCOPES, FORTNOX_SCOPES_NOT_REQUESTED, scopeParam } from './scopes.js';
import { FortnoxOAuthError, FortnoxTokenClient } from './token-client.js';

const KEY = loadEncryptionKey(generateEncryptionKey());
const CONTEXT = { tenantId: 'firm-trimeros', clientId: 'client-1', kind: 'refresh_token' };

describe('scopes', () => {
  it('requests no scope that could permit writing', () => {
    for (const scope of FORTNOX_READ_SCOPES) {
      expect(scope).not.toMatch(/write|admin|delete/i);
    }
  });

  it('does not request scopes that were never verified', () => {
    for (const unrequested of Object.keys(FORTNOX_SCOPES_NOT_REQUESTED)) {
      expect(FORTNOX_READ_SCOPES).not.toContain(unrequested);
    }
  });

  it('joins scopes with spaces as the authorize endpoint expects', () => {
    expect(scopeParam(['a', 'b'])).toBe('a b');
  });
});

describe('authorize url', () => {
  const input = {
    clientId: 'client-abc',
    redirectUri: 'https://api.example.com/api/integrations/fortnox/callback',
    state: 'state-value',
  };

  it('carries every parameter Fortnox requires', () => {
    const url = new URL(buildAuthorizeUrl(input));
    expect(url.origin + url.pathname).toBe('https://apps.fortnox.se/oauth-v1/auth');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe(input.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('account_type')).toBe('service');
  });

  it('always asks for offline access, or the connection would die in an hour', () => {
    const url = new URL(buildAuthorizeUrl(input));
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('requests the read scopes', () => {
    const url = new URL(buildAuthorizeUrl(input));
    expect(url.searchParams.get('scope')).toBe(FORTNOX_READ_SCOPES.join(' '));
  });

  it('generates unpredictable, non-repeating state', () => {
    const states = new Set(Array.from({ length: 200 }, () => generateState()));
    expect(states.size).toBe(200);
    expect(generateState().length).toBeGreaterThanOrEqual(40);
  });

  it('matches a presented state against its stored hash', () => {
    const state = generateState();
    const stored = hashState(state);
    expect(stored).not.toContain(state);
    expect(stateMatches(state, stored)).toBe(true);
    expect(stateMatches(generateState(), stored)).toBe(false);
    expect(stateMatches(state, 'not-a-hash')).toBe(false);
  });
});

describe('token sealing', () => {
  it('round-trips a token', () => {
    const sealed = sealSecret(KEY, 'refresh-token-value', CONTEXT);
    expect(sealed).not.toContain('refresh-token-value');
    expect(openSecret(KEY, sealed, CONTEXT)).toBe('refresh-token-value');
  });

  it('refuses a ciphertext moved to another client', () => {
    const sealed = sealSecret(KEY, 'refresh-token-value', CONTEXT);
    expect(() => openSecret(KEY, sealed, { ...CONTEXT, clientId: 'client-2' })).toThrow(
      SealedSecretError,
    );
  });

  it('refuses a ciphertext opened with the wrong key', () => {
    const sealed = sealSecret(KEY, 'refresh-token-value', CONTEXT);
    const other = loadEncryptionKey(generateEncryptionKey());
    expect(() => openSecret(other, sealed, CONTEXT)).toThrow(SealedSecretError);
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = sealSecret(KEY, 'refresh-token-value', CONTEXT);
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3] ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => openSecret(KEY, parts.join('.'), CONTEXT)).toThrow(SealedSecretError);
  });

  it('rejects a malformed envelope rather than guessing', () => {
    expect(() => openSecret(KEY, 'v2.a.b.c', CONTEXT)).toThrow(SealedSecretError);
    expect(() => openSecret(KEY, 'nonsense', CONTEXT)).toThrow(SealedSecretError);
  });

  it('fails closed when the key is missing or the wrong size', () => {
    expect(() => loadEncryptionKey(undefined)).toThrow(EncryptionKeyError);
    expect(() => loadEncryptionKey('')).toThrow(EncryptionKeyError);
    expect(() => loadEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(EncryptionKeyError);
  });

  it('fingerprints a token without revealing it', () => {
    const fp = secretFingerprint(KEY, 'refresh-token-value');
    expect(fp).toHaveLength(12);
    expect(fp).toBe(secretFingerprint(KEY, 'refresh-token-value'));
    expect(fp).not.toBe(secretFingerprint(KEY, 'other-token'));
    expect('refresh-token-value').not.toContain(fp);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TOKEN_BODY = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'companyinformation bookkeeping',
};

describe('token client', () => {
  it('authenticates with HTTP Basic and posts a form body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(TOKEN_BODY));
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(fetchImpl),
    });

    await client.exchangeAuthorizationCode({ code: 'abc', redirectUri: 'https://x/cb' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://apps.fortnox.se/oauth-v1/token');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('abc');
    expect(body.get('redirect_uri')).toBe('https://x/cb');
  });

  it('parses a token response', async () => {
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(async () => jsonResponse(TOKEN_BODY)),
    });
    const tokens = await client.exchangeAuthorizationCode({ code: 'a', redirectUri: 'b' });
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresInSeconds).toBe(3600);
    expect(tokens.grantedScopes).toEqual(['companyinformation', 'bookkeeping']);
  });

  it('sends the refresh grant', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...TOKEN_BODY, refresh_token: 'refresh-2' }));
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(fetchImpl),
    });
    const tokens = await client.refresh('refresh-1');
    const body = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    // Fortnox rotates: the response carries the token to store next time.
    expect(tokens.refreshToken).toBe('refresh-2');
  });

  it('never retries, because both grants are single-use', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'server_error' }, 500));
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(fetchImpl),
    });
    await expect(client.refresh('refresh-1')).rejects.toThrow(FortnoxOAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('flags a dead grant as needing a reconnect', async () => {
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: (async () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'expired' }, 400)),
    });
    await expect(client.refresh('old')).rejects.toMatchObject({
      code: 'invalid_grant',
      requiresReconnect: true,
    });
  });

  it('does not treat a transient 503 as a dead grant', async () => {
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(async () => jsonResponse({ error: 'temporarily_unavailable' }, 503)),
    });
    await expect(client.refresh('r')).rejects.toMatchObject({ requiresReconnect: false });
  });

  it('rejects a response with no refresh token', async () => {
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(async () => jsonResponse({ access_token: 'a', expires_in: 3600 })),
    });
    await expect(client.exchangeAuthorizationCode({ code: 'a', redirectUri: 'b' })).rejects.toMatchObject(
      { code: 'missing_refresh_token' },
    );
  });

  it('refuses to construct without client credentials', () => {
    expect(() => new FortnoxTokenClient({ clientId: '', clientSecret: '' })).toThrow(
      FortnoxOAuthError,
    );
  });

  it('reports a failed revocation instead of blocking disconnect', async () => {
    const client = new FortnoxTokenClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: asHttpFetch(async () => {
        throw new Error('network down');
      }),
    });
    await expect(client.revoke('r')).resolves.toEqual({ revokedAtFortnox: false });
  });
});
