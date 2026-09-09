import { asHttpFetch, type HttpFetch, type HttpResponse } from '@trimeros/domain';
import { FORTNOX_OAUTH_DEFAULTS } from './endpoints.js';

/**
 * The Fortnox token endpoint.
 *
 * Per Fortnox's authorization documentation the endpoint is
 * `POST https://apps.fortnox.se/oauth-v1/token`, form-encoded, with the client
 * id and secret in an HTTP Basic header.
 *
 * **No request here is ever retried.** Both grants consume a single-use
 * credential: an authorization code is valid once, and a refresh rotates -
 * Fortnox invalidates the old refresh token the moment it issues a new one. A
 * retry after a lost response would present a credential the server has already
 * spent and turn a recoverable timeout into a dead connection. Callers get the
 * failure and Marcus reconnects; that is the honest outcome.
 */

export interface FortnoxTokenClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenUrl?: string;
  readonly revokeUrl?: string;
  readonly timeoutMs?: number;
  /** Structural, so this file does not depend on ambient fetch typings. */
  readonly fetchImpl?: HttpFetch;
}

/** A token response. Callers must seal these before they touch storage. */
export interface FortnoxTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly tokenType: string;
  readonly grantedScopes: readonly string[];
}

export class FortnoxOAuthError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;
  /** True when the stored grant is gone for good and only a fresh consent helps. */
  readonly requiresReconnect: boolean;

  constructor(params: {
    code: string;
    message: string;
    httpStatus?: number;
    requiresReconnect?: boolean;
  }) {
    super(params.message);
    this.name = 'FortnoxOAuthError';
    this.code = params.code;
    this.httpStatus = params.httpStatus;
    this.requiresReconnect = params.requiresReconnect ?? false;
  }
}

/** Grants that a new access token cannot rescue. */
const TERMINAL_ERRORS = new Set(['invalid_grant', 'unauthorized_client', 'access_denied']);

export class FortnoxTokenClient {
  readonly #options: FortnoxTokenClientOptions;

  constructor(options: FortnoxTokenClientOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new FortnoxOAuthError({
        code: 'client_not_configured',
        message: 'FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET must both be set.',
      });
    }
    this.#options = options;
  }

  /**
   * Resolved per call rather than captured in the constructor.
   *
   * Binding `globalThis.fetch` at construction quietly outlives any later
   * replacement of it, which makes the transport depend on when the object
   * happened to be built. Looking it up here keeps that from mattering.
   */
  get #fetch(): HttpFetch {
    return this.#options.fetchImpl ?? asHttpFetch(globalThis.fetch);
  }

  async exchangeAuthorizationCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<FortnoxTokenSet> {
    return this.#post({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<FortnoxTokenSet> {
    return this.#post({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /**
   * Best-effort revocation on disconnect.
   *
   * Revocation is documented, but treating a failure here as fatal would leave
   * a client unable to disconnect. The local credential is deleted either way;
   * the caller is told whether Fortnox confirmed.
   */
  async revoke(refreshToken: string): Promise<{ revokedAtFortnox: boolean }> {
    const url = this.#options.revokeUrl ?? FORTNOX_OAUTH_DEFAULTS.revokeUrl;
    try {
      const response = await this.#send(url, new URLSearchParams({ token: refreshToken }));
      return { revokedAtFortnox: response.ok };
    } catch {
      return { revokedAtFortnox: false };
    }
  }

  async #post(body: Record<string, string>): Promise<FortnoxTokenSet> {
    const url = this.#options.tokenUrl ?? FORTNOX_OAUTH_DEFAULTS.tokenUrl;
    const response = await this.#send(url, new URLSearchParams(body));
    const raw = await response.text();

    if (!response.ok) {
      throw toOAuthError(raw, response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FortnoxOAuthError({
        code: 'invalid_token_response',
        message: 'Token endpoint returned a body that is not JSON.',
        httpStatus: response.status,
      });
    }
    return toTokenSet(parsed, response.status);
  }

  async #send(url: string, body: URLSearchParams): Promise<HttpResponse> {
    const credentials = Buffer.from(
      `${this.#options.clientId}:${this.#options.clientSecret}`,
      'utf8',
    ).toString('base64');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000);
    try {
      return await this.#fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new FortnoxOAuthError({
          code: 'token_request_timeout',
          message: 'The Fortnox token endpoint did not answer in time.',
        });
      }
      throw new FortnoxOAuthError({
        code: 'token_request_failed',
        message: `Could not reach the Fortnox token endpoint: ${describe(error)}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Maps an error body to a typed error.
 *
 * The body is parsed for the standard `error` field only. `error_description`
 * is passed through, but nothing else from the response is retained: an error
 * body can echo request parameters, and those include a token.
 */
function toOAuthError(raw: string, status: number): FortnoxOAuthError {
  let code = `http_${status}`;
  let description = 'The Fortnox token endpoint rejected the request.';
  try {
    const body = JSON.parse(raw) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) code = body.error;
    if (typeof body.error_description === 'string' && body.error_description.length > 0) {
      description = body.error_description;
    }
  } catch {
    // Non-JSON error body; the status code is all we can say for certain.
  }
  return new FortnoxOAuthError({
    code,
    message: description,
    httpStatus: status,
    requiresReconnect: TERMINAL_ERRORS.has(code) || status === 400 || status === 401,
  });
}

function toTokenSet(parsed: unknown, status: number): FortnoxTokenSet {
  const body = parsed as Record<string, unknown>;
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new FortnoxOAuthError({
      code: 'missing_access_token',
      message: 'Token response contained no access_token.',
      httpStatus: status,
    });
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    // Without a refresh token the connection expires in an hour and Marcus
    // would have to redo consent. Usually means access_type=offline was lost.
    throw new FortnoxOAuthError({
      code: 'missing_refresh_token',
      message:
        'Token response contained no refresh_token. The authorization request must use access_type=offline.',
      httpStatus: status,
    });
  }

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  const scope = typeof body.scope === 'string' ? body.scope : '';

  return {
    accessToken,
    refreshToken,
    expiresInSeconds: expiresIn,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    grantedScopes: scope.split(/[\s,]+/).filter(Boolean),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
