import type {
  AuthorizationRequestRecord,
  ConnectionRecord,
  ConnectionScope,
  CredentialRecord,
  FortnoxConnectionStore,
} from './store.js';

/**
 * An in-memory `FortnoxConnectionStore`.
 *
 * Exported rather than hidden in a test file so the OAuth flow can be
 * exercised - including its concurrency behaviour - without a database, and so
 * a future integration test can diff its behaviour against the real one.
 */
export class InMemoryConnectionStore implements FortnoxConnectionStore {
  readonly connections = new Map<string, ConnectionRecord>();
  readonly credentials = new Map<string, CredentialRecord>();
  readonly requests = new Map<string, AuthorizationRequestRecord>();
  #seq = 0;

  #key(scope: ConnectionScope, kind: string): string {
    return `${scope.tenantId}|${scope.clientId}|${kind}`;
  }

  async getIntegrationConnection(scope: ConnectionScope, kind?: string) {
    if (kind) return this.connections.get(this.#key(scope, kind));
    return [...this.connections.values()].find(
      (c) => c.tenantId === scope.tenantId && c.clientId === scope.clientId,
    );
  }

  async upsertIntegrationConnection(
    input: Parameters<FortnoxConnectionStore['upsertIntegrationConnection']>[0],
  ): Promise<ConnectionRecord> {
    const key = this.#key(input, input.kind);
    const existing = this.connections.get(key);
    const row: ConnectionRecord = {
      id: existing?.id ?? input.id ?? `conn-${++this.#seq}`,
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind,
      mode: input.mode,
      scopes: input.scopes,
      credentialRef: input.credentialRef ?? null,
      writesEnabled: input.writesEnabled ?? false,
      healthy: input.healthy ?? true,
      status: input.status ?? 'disconnected',
      statusCode: input.statusCode ?? null,
      statusChangedAt: input.statusChangedAt ?? null,
      connectedAt: input.connectedAt ?? null,
      connectedByUserId: input.connectedByUserId ?? null,
      remoteCompanyName: input.remoteCompanyName ?? null,
      remoteOrganisationNumber: input.remoteOrganisationNumber ?? null,
      lastCheckedAt: input.lastCheckedAt ?? null,
    };
    this.connections.set(key, row);
    return row;
  }

  async updateIntegrationConnection(
    scope: ConnectionScope,
    kind: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const key = this.#key(scope, kind);
    const existing = this.connections.get(key);
    if (!existing) return;
    this.connections.set(key, { ...existing, ...patch } as ConnectionRecord);
  }

  async createAuthorizationRequest(
    input: Parameters<FortnoxConnectionStore['createAuthorizationRequest']>[0],
  ): Promise<AuthorizationRequestRecord> {
    const row: AuthorizationRequestRecord = {
      id: input.id ?? `req-${++this.#seq}`,
      tenantId: input.tenantId,
      clientId: input.clientId,
      provider: input.provider,
      stateHash: input.stateHash,
      redirectUri: input.redirectUri,
      requestedScopes: input.requestedScopes,
      initiatedByUserId: input.initiatedByUserId,
      returnTo: input.returnTo ?? null,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.requests.set(row.stateHash, row);
    return row;
  }

  async consumeAuthorizationRequest(
    stateHash: string,
    now: Date = new Date(),
  ): Promise<AuthorizationRequestRecord | undefined> {
    const row = this.requests.get(stateHash);
    if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
      return undefined;
    }
    const consumed = { ...row, consumedAt: now };
    this.requests.set(stateHash, consumed);
    return consumed;
  }

  async deleteExpiredAuthorizationRequests(now: Date = new Date()): Promise<void> {
    for (const [hash, row] of this.requests) {
      if (row.expiresAt.getTime() <= now.getTime()) this.requests.delete(hash);
    }
  }

  async getIntegrationCredential(scope: ConnectionScope, kind: string) {
    return this.credentials.get(this.#key(scope, kind));
  }

  async upsertIntegrationCredential(
    input: Parameters<FortnoxConnectionStore['upsertIntegrationCredential']>[0],
  ): Promise<CredentialRecord> {
    const key = this.#key(input, input.kind);
    const row: CredentialRecord = {
      id: input.id ?? `cred-${++this.#seq}`,
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind,
      sealedAccessToken: input.sealedAccessToken ?? null,
      sealedRefreshToken: input.sealedRefreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
      grantedScopes: input.grantedScopes,
      refreshTokenFingerprint: input.refreshTokenFingerprint,
      rotationCount: input.rotationCount ?? 0,
      rotatedAt: input.rotatedAt ?? null,
    };
    this.credentials.set(key, row);
    return row;
  }

  async rotateIntegrationCredential(
    scope: ConnectionScope,
    kind: string,
    expectedRotationCount: number,
    patch: Parameters<FortnoxConnectionStore['rotateIntegrationCredential']>[3],
  ): Promise<boolean> {
    const key = this.#key(scope, kind);
    const existing = this.credentials.get(key);
    if (!existing || existing.rotationCount !== expectedRotationCount) return false;
    this.credentials.set(key, {
      ...existing,
      ...patch,
      rotationCount: expectedRotationCount + 1,
    });
    return true;
  }

  async deleteIntegrationCredential(scope: ConnectionScope, kind: string): Promise<void> {
    this.credentials.delete(this.#key(scope, kind));
  }
}
