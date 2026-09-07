/**
 * Fortnox OAuth2 endpoints.
 *
 * Corroborated against Fortnox's own authorization documentation
 * (www.fortnox.se/developer/authorization). They live on `apps.fortnox.se`,
 * which is a different host from the resource API (`api.fortnox.se`) - a
 * distinction that is easy to get wrong and produces a confusing 404 rather
 * than an auth error.
 *
 * They are overridable by environment variable so a future sandbox or a
 * documentation correction does not require a code change.
 */
export const FORTNOX_OAUTH_DEFAULTS = {
  authorizeUrl: 'https://apps.fortnox.se/oauth-v1/auth',
  tokenUrl: 'https://apps.fortnox.se/oauth-v1/token',
  revokeUrl: 'https://apps.fortnox.se/oauth-v1/revoke',
  apiBaseUrl: 'https://api.fortnox.se',
} as const;

/**
 * How long Fortnox says each artefact lives. Used to set our own expiry
 * bookkeeping, never to decide that a token is still good - a 401 from Fortnox
 * always wins over our arithmetic.
 */
export const FORTNOX_TOKEN_LIFETIMES = {
  /** The authorization code is single-use and short-lived. */
  authorizationCodeSeconds: 10 * 60,
  /** Documented as one hour. The token response's `expires_in` takes priority. */
  accessTokenSeconds: 60 * 60,
  /** Documented as 45 days, and it rotates on every refresh. */
  refreshTokenSeconds: 45 * 24 * 60 * 60,
} as const;

/**
 * Safety margin applied before an access token is considered expired.
 *
 * Without it a token that expires mid-flight produces a 401 in the middle of a
 * read rather than a refresh before it.
 */
export const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;
