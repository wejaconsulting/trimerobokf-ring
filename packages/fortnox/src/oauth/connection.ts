import {
  FORTNOX_CONNECTION_KIND,
  asHttpFetch,
  type HttpFetch,
  type HttpResponse,
} from '@trimeros/domain';
import { buildAuthorizeUrl, generateState, hashState } from './authorize.js';
import {
  openSecret,
  sealSecret,
  secretFingerprint,
  type SecretContext,
} from './crypto.js';
import {
  ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
  FORTNOX_OAUTH_DEFAULTS,
  FORTNOX_TOKEN_LIFETIMES,
} from './endpoints.js';
import { FORTNOX_READ_SCOPES } from './scopes.js';
import type {
  ConnectionRecord,
  ConnectionScope,
  CredentialRecord,
  FortnoxConnectionStore,
} from './store.js';
import { FortnoxOAuthError, type FortnoxTokenClient, type FortnoxTokenSet } from './token-client.js';

/**
 * The Fortnox connection.
 *
 * One object owns the whole lifecycle: start consent, finish it, hand out an
 * access token, report status, disconnect. Concentrating it here means there is
 * one place where a token is ever in plaintext, and it is a local variable.
 *
 * What this service deliberately does NOT do:
 *
 *  - It does not enable writing. A connection is read-only by construction: no
 *    write scope is requested, and `createVoucher` still has to pass the
 *    seven-condition gate in write-policy.ts, which shadow mode fails.
 *  - It does not hand tokens to anything model-facing. `getAccessToken`
 *    returns a string to the HTTP adapter and nothing else calls it.
 */

export type ConnectionStatus = 'disconnected' | 'connected' | 'needs_reconnect';

export interface ConnectionSummary {
  readonly status: ConnectionStatus;
  readonly clientId: string;
  /** Present once a connection test has succeeded. */
  readonly companyName: string | null;
  readonly organisationNumber: string | null;
  readonly grantedScopes: readonly string[];
  readonly connectedAt: Date | null;
  readonly connectedByUserId: string | null;
  /** When the stored refresh token stops working unless it is used first. */
  readonly refreshTokenExpiresAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly healthy: boolean;
  readonly statusCode: string | null;
  /** Always false in this phase; surfaced so the UI reports rather than assumes. */
  readonly writesEnabled: boolean;
}

export interface FortnoxConnectionServiceOptions {
  readonly store: FortnoxConnectionStore;
  readonly tokenClient: FortnoxTokenClient;
  readonly encryptionKey: Buffer;
  readonly clientId: string;
  readonly authorizeUrl?: string;
  readonly apiBaseUrl?: string;
  readonly scopes?: readonly string[];
  readonly fetchImpl?: HttpFetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export interface BeginAuthorizationInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly initiatedByUserId: string;
  /** Must exactly match a redirect URI registered on the Fortnox app. */
  readonly redirectUri: string;
  readonly returnTo?: string;
}

export interface CompleteAuthorizationInput {
  readonly state: string;
  readonly code: string;
}

export interface CompleteAuthorizationResult {
  readonly summary: ConnectionSummary;
  readonly returnTo: string | null;
  readonly tenantId: string;
  readonly clientId: string;
}

export class FortnoxConnectionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FortnoxConnectionError';
    this.code = code;
  }
}

export class FortnoxConnectionService {
  readonly #options: FortnoxConnectionServiceOptions;
  readonly #now: () => Date;
  /** In-flight refreshes, keyed by tenant+client. See `#refreshTokens`. */
  readonly #refreshInFlight = new Map<string, Promise<string>>();

  constructor(options: FortnoxConnectionServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** Resolved per call, for the reason given in FortnoxTokenClient. */
  get #fetch(): HttpFetch {
    return this.#options.fetchImpl ?? asHttpFetch(globalThis.fetch);
  }

  // --- consent ------------------------------------------------------------

  /**
   * Starts consent and returns the URL to send the person to.
   *
   * The state is generated here, stored as a hash, and expires with Fortnox's
   * ten-minute authorization code. Expired requests are swept on the way past,
   * which keeps the table from accumulating dead rows without a scheduler.
   */
  async beginAuthorization(input: BeginAuthorizationInput): Promise<{
    authorizeUrl: string;
    expiresAt: Date;
  }> {
    const now = this.#now();
    await this.#options.store.deleteExpiredAuthorizationRequests(now);

    const state = generateState();
    const scopes = [...(this.#options.scopes ?? FORTNOX_READ_SCOPES)];
    const expiresAt = new Date(
      now.getTime() + FORTNOX_TOKEN_LIFETIMES.authorizationCodeSeconds * 1000,
    );

    await this.#options.store.createAuthorizationRequest({
      tenantId: input.tenantId,
      clientId: input.clientId,
      provider: FORTNOX_CONNECTION_KIND,
      stateHash: hashState(state),
      redirectUri: input.redirectUri,
      requestedScopes: scopes,
      initiatedByUserId: input.initiatedByUserId,
      returnTo: input.returnTo ?? null,
      expiresAt,
    });

    return {
      authorizeUrl: buildAuthorizeUrl({
        clientId: this.#options.clientId,
        redirectUri: input.redirectUri,
        state,
        scopes,
        authorizeUrl: this.#options.authorizeUrl,
      }),
      expiresAt,
    };
  }

  /**
   * Finishes consent.
   *
   * The state is claimed atomically before the code is spent, so a replayed or
   * expired callback fails without ever reaching Fortnox.
   */
  async completeAuthorization(
    input: CompleteAuthorizationInput,
  ): Promise<CompleteAuthorizationResult> {
    const now = this.#now();
    const request = await this.#options.store.consumeAuthorizationRequest(
      hashState(input.state),
      now,
    );
    if (!request) {
      throw new FortnoxConnectionError(
        'invalid_state',
        'This authorization link is unknown, already used or older than ten minutes. Start the connection again.',
      );
    }

    const scope: ConnectionScope = { tenantId: request.tenantId, clientId: request.clientId };

    let tokens: FortnoxTokenSet;
    try {
      tokens = await this.#options.tokenClient.exchangeAuthorizationCode({
        code: input.code,
        redirectUri: request.redirectUri,
      });
    } catch (error) {
      await this.#markStatus(scope, 'disconnected', codeOf(error));
      throw error;
    }

    await this.#storeTokens(scope, tokens, now, { rotation: false });

    await this.#options.store.upsertIntegrationConnection({
      tenantId: scope.tenantId,
      clientId: scope.clientId,
      kind: FORTNOX_CONNECTION_KIND,
      mode: 'real_read_only',
      scopes: [...tokens.grantedScopes],
      credentialRef: credentialRef(scope),
      // Consent grants reading. Writing stays gated regardless of what is
      // stored here, and this column is never flipped by this code path.
      writesEnabled: false,
      healthy: true,
      status: 'connected',
      statusCode: null,
      statusChangedAt: now,
      connectedAt: now,
      connectedByUserId: request.initiatedByUserId,
    });

    // Prove the credential works before telling anyone it does.
    const summary = await this.verifyConnection(scope);
    return {
      summary,
      returnTo: request.returnTo,
      tenantId: scope.tenantId,
      clientId: scope.clientId,
    };
  }

  // --- status -------------------------------------------------------------

  async getStatus(scope: ConnectionScope): Promise<ConnectionSummary> {
    const [connection, credential] = await Promise.all([
      this.#options.store.getIntegrationConnection(scope, FORTNOX_CONNECTION_KIND),
      this.#options.store.getIntegrationCredential(scope, FORTNOX_CONNECTION_KIND),
    ]);
    return summarise(scope.clientId, connection, credential);
  }

  /**
   * Calls Fortnox once and records what came back.
   *
   * A stored token that has never been used is a guess. This turns it into a
   * fact, and gives the console a company name to show instead of "connected".
   */
  async verifyConnection(scope: ConnectionScope): Promise<ConnectionSummary> {
    const now = this.#now();
    try {
      const company = await this.#fetchCompanyInformation(scope);
      await this.#options.store.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
        healthy: true,
        status: 'connected',
        statusCode: null,
        statusChangedAt: now,
        lastCheckedAt: now,
        remoteCompanyName: company.name,
        remoteOrganisationNumber: company.organisationNumber,
      });
    } catch (error) {
      const code = codeOf(error);
      const dead = error instanceof FortnoxOAuthError && error.requiresReconnect;
      await this.#options.store.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
        healthy: false,
        // A failed verification is not automatically a dead grant: a 404 on the
        // company endpoint says our URL is wrong, not that consent lapsed.
        ...(dead ? { status: 'needs_reconnect' as const, statusChangedAt: now } : {}),
        statusCode: code,
        lastCheckedAt: now,
      });
    }
    return this.getStatus(scope);
  }

  async disconnect(scope: ConnectionScope): Promise<{ revokedAtFortnox: boolean }> {
    const now = this.#now();
    const credential = await this.#options.store.getIntegrationCredential(
      scope,
      FORTNOX_CONNECTION_KIND,
    );

    let revokedAtFortnox = false;
    if (credential) {
      try {
        const refreshToken = openSecret(
          this.#options.encryptionKey,
          credential.sealedRefreshToken,
          secretContext(scope, 'refresh_token'),
        );
        ({ revokedAtFortnox } = await this.#options.tokenClient.revoke(refreshToken));
      } catch {
        // An unopenable or unrevokable token still gets deleted below. Failing
        // to disconnect because a secret is already broken helps nobody.
      }
    }

    await this.#options.store.deleteIntegrationCredential(scope, FORTNOX_CONNECTION_KIND);
    await this.#options.store.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
      credentialRef: null,
      healthy: true,
      status: 'disconnected',
      statusCode: null,
      statusChangedAt: now,
      connectedAt: null,
      connectedByUserId: null,
      remoteCompanyName: null,
      remoteOrganisationNumber: null,
      lastCheckedAt: now,
    });
    return { revokedAtFortnox };
  }

  // --- tokens -------------------------------------------------------------

  /**
   * Returns a usable access token, refreshing first if needed.
   *
   * Concurrency matters here more than usual. Fortnox rotates the refresh
   * token on every use and invalidates the previous one, so two simultaneous
   * refreshes would leave one caller holding a token the server has already
   * revoked. Two things prevent that: refreshes for the same connection share
   * one in-flight promise, and the write that persists a rotation is a
   * compare-and-set on `rotationCount`, so a loser re-reads instead of
   * overwriting.
   */
  async getAccessToken(scope: ConnectionScope): Promise<string> {
    const credential = await this.#options.store.getIntegrationCredential(
      scope,
      FORTNOX_CONNECTION_KIND,
    );
    if (!credential) {
      throw new FortnoxConnectionError(
        'not_connected',
        'This client is not connected to Fortnox.',
      );
    }

    const now = this.#now();
    if (
      credential.sealedAccessToken &&
      credential.accessTokenExpiresAt &&
      credential.accessTokenExpiresAt.getTime() - ACCESS_TOKEN_REFRESH_SKEW_SECONDS * 1000 >
        now.getTime()
    ) {
      return openSecret(
        this.#options.encryptionKey,
        credential.sealedAccessToken,
        secretContext(scope, 'access_token'),
      );
    }

    const key = `${scope.tenantId}|${scope.clientId}`;
    const existing = this.#refreshInFlight.get(key);
    if (existing) return existing;

    const inFlight = this.#refreshTokens(scope, credential.rotationCount).finally(() => {
      this.#refreshInFlight.delete(key);
    });
    this.#refreshInFlight.set(key, inFlight);
    return inFlight;
  }

  async #refreshTokens(scope: ConnectionScope, expectedRotationCount: number): Promise<string> {
    const credential = await this.#options.store.getIntegrationCredential(
      scope,
      FORTNOX_CONNECTION_KIND,
    );
    if (!credential) {
      throw new FortnoxConnectionError('not_connected', 'This client is not connected to Fortnox.');
    }

    const refreshToken = openSecret(
      this.#options.encryptionKey,
      credential.sealedRefreshToken,
      secretContext(scope, 'refresh_token'),
    );

    let tokens: FortnoxTokenSet;
    try {
      tokens = await this.#options.tokenClient.refresh(refreshToken);
    } catch (error) {
      if (error instanceof FortnoxOAuthError && error.requiresReconnect) {
        // The grant is gone. Keeping the dead secret would be a liability with
        // no upside, so it is deleted and the console asks for a reconnect.
        await this.#options.store.deleteIntegrationCredential(scope, FORTNOX_CONNECTION_KIND);
        await this.#options.store.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
          credentialRef: null,
          healthy: false,
          status: 'needs_reconnect',
          statusCode: error.code,
          statusChangedAt: this.#now(),
        });
      }
      throw error;
    }

    const now = this.#now();
    const stored = await this.#storeTokens(scope, tokens, now, {
      rotation: true,
      expectedRotationCount,
    });

    if (!stored) {
      // Another refresh won the race and persisted its own token. Ours is now
      // the dead one, so use theirs rather than either token being lost.
      const winner = await this.#options.store.getIntegrationCredential(
        scope,
        FORTNOX_CONNECTION_KIND,
      );
      if (winner?.sealedAccessToken) {
        return openSecret(
          this.#options.encryptionKey,
          winner.sealedAccessToken,
          secretContext(scope, 'access_token'),
        );
      }
    }
    return tokens.accessToken;
  }

  /** Seals and persists a token set. Returns false only if a rotation lost a race. */
  async #storeTokens(
    scope: ConnectionScope,
    tokens: FortnoxTokenSet,
    now: Date,
    mode: { rotation: boolean; expectedRotationCount?: number },
  ): Promise<boolean> {
    const key = this.#options.encryptionKey;
    const accessTokenExpiresAt = new Date(now.getTime() + tokens.expiresInSeconds * 1000);
    const refreshTokenExpiresAt = new Date(
      now.getTime() + FORTNOX_TOKEN_LIFETIMES.refreshTokenSeconds * 1000,
    );
    const sealedAccessToken = sealSecret(key, tokens.accessToken, secretContext(scope, 'access_token'));
    const sealedRefreshToken = sealSecret(
      key,
      tokens.refreshToken,
      secretContext(scope, 'refresh_token'),
    );
    const fingerprint = secretFingerprint(key, tokens.refreshToken);

    if (mode.rotation) {
      return this.#options.store.rotateIntegrationCredential(
        scope,
        FORTNOX_CONNECTION_KIND,
        mode.expectedRotationCount ?? 0,
        {
          sealedAccessToken,
          sealedRefreshToken,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
          grantedScopes: [...tokens.grantedScopes],
          refreshTokenFingerprint: fingerprint,
          rotatedAt: now,
        },
      );
    }

    await this.#options.store.upsertIntegrationCredential({
      id: credentialRef(scope),
      tenantId: scope.tenantId,
      clientId: scope.clientId,
      kind: FORTNOX_CONNECTION_KIND,
      sealedAccessToken,
      sealedRefreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt,
      grantedScopes: [...tokens.grantedScopes],
      refreshTokenFingerprint: fingerprint,
      rotationCount: 0,
      rotatedAt: null,
    });
    return true;
  }

  // --- the one live read --------------------------------------------------

  /**
   * Reads company information as a connectivity check.
   *
   * `companyinformation` is a verified scope; the path below follows the same
   * `/3/<resource>` convention as every other entry in FORTNOX_ENDPOINTS but
   * was not confirmed byte-for-byte from this environment. If it is wrong the
   * failure is a clearly-labelled 404 on the settings page, not silent
   * breakage - see docs/fortnox-oauth.md.
   */
  async #fetchCompanyInformation(
    scope: ConnectionScope,
  ): Promise<{ name: string | null; organisationNumber: string | null }> {
    const token = await this.getAccessToken(scope);
    const base = this.#options.apiBaseUrl ?? FORTNOX_OAUTH_DEFAULTS.apiBaseUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000);
    let response: HttpResponse;
    try {
      response = await this.#fetch(`${base}/3/companyinformation`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new FortnoxOAuthError({
        code: controller.signal.aborted ? 'company_check_timeout' : 'company_check_failed',
        message: `Could not reach the Fortnox API: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new FortnoxOAuthError({
        code: `company_check_http_${response.status}`,
        message: `Fortnox answered ${response.status} for the company-information check.`,
        httpStatus: response.status,
        // Only an auth failure means the grant itself is bad.
        requiresReconnect: response.status === 401,
      });
    }

    // Parsed defensively: a missing name makes the connection nameless, not failed.
    try {
      const body = (await response.json()) as {
        CompanyInformation?: { CompanyName?: unknown; Name?: unknown; OrganizationNumber?: unknown };
      };
      const info = body.CompanyInformation ?? {};
      const name =
        typeof info.CompanyName === 'string'
          ? info.CompanyName
          : typeof info.Name === 'string'
            ? info.Name
            : null;
      return {
        name,
        organisationNumber:
          typeof info.OrganizationNumber === 'string' ? info.OrganizationNumber : null,
      };
    } catch {
      return { name: null, organisationNumber: null };
    }
  }

  async #markStatus(scope: ConnectionScope, status: ConnectionStatus, code: string): Promise<void> {
    await this.#options.store.updateIntegrationConnection(scope, FORTNOX_CONNECTION_KIND, {
      status,
      statusCode: code,
      statusChangedAt: this.#now(),
      healthy: status === 'connected',
    });
  }
}

function credentialRef(scope: ConnectionScope): string {
  return `fortnox:${scope.tenantId}:${scope.clientId}`;
}

function secretContext(scope: ConnectionScope, kind: string): SecretContext {
  return { tenantId: scope.tenantId, clientId: scope.clientId, kind };
}

function codeOf(error: unknown): string {
  if (error instanceof FortnoxOAuthError) return error.code;
  if (error instanceof FortnoxConnectionError) return error.code;
  return 'unknown_error';
}

function summarise(
  clientId: string,
  connection: ConnectionRecord | undefined,
  credential: CredentialRecord | undefined,
): ConnectionSummary {
  const status = (connection?.status as ConnectionStatus | undefined) ?? 'disconnected';
  return {
    // A connection row claiming "connected" with no credential is a lie the UI
    // should never repeat, so the credential decides.
    status: credential ? status : status === 'needs_reconnect' ? 'needs_reconnect' : 'disconnected',
    clientId,
    companyName: connection?.remoteCompanyName ?? null,
    organisationNumber: connection?.remoteOrganisationNumber ?? null,
    grantedScopes: credential?.grantedScopes ?? [],
    connectedAt: connection?.connectedAt ?? null,
    connectedByUserId: connection?.connectedByUserId ?? null,
    refreshTokenExpiresAt: credential?.refreshTokenExpiresAt ?? null,
    lastCheckedAt: connection?.lastCheckedAt ?? null,
    healthy: connection?.healthy ?? false,
    statusCode: connection?.statusCode ?? null,
    writesEnabled: connection?.writesEnabled ?? false,
  };
}
