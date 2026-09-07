import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { FORTNOX_OAUTH_DEFAULTS } from './endpoints.js';
import { scopeParam, FORTNOX_READ_SCOPES } from './scopes.js';

/**
 * The authorization request.
 *
 * `state` is not decoration. It is the only thing tying the browser that comes
 * back from Fortnox to the request we started, so it is generated with a CSPRNG,
 * stored as a hash, single-use, and expires with the authorization code.
 */

export interface AuthorizeUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly authorizeUrl?: string;
  /**
   * Fortnox's documented value for an integration acting on a company's behalf.
   * Overridable because the alternative values are not documented publicly.
   */
  readonly accountType?: string;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizeUrl ?? FORTNOX_OAUTH_DEFAULTS.authorizeUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', scopeParam(input.scopes ?? FORTNOX_READ_SCOPES));
  url.searchParams.set('state', input.state);
  url.searchParams.set('response_type', 'code');
  // Without offline access Fortnox issues no refresh token, and the connection
  // would silently die an hour after Marcus sets it up.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('account_type', input.accountType ?? 'service');
  return url.toString();
}

/** 256 bits of CSPRNG output, URL-safe. */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What we persist.
 *
 * Storing the hash rather than the value means a leaked database row cannot be
 * replayed as a valid callback.
 */
export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented state against a stored hash. */
export function stateMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashState(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
