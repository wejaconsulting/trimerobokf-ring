/**
 * The storage the connection service needs.
 *
 * Declared here as a narrow port rather than importing `@trimeros/db`, so the
 * OAuth layer stays testable with an in-memory fake and the Fortnox package
 * keeps no database dependency. `Repositories` satisfies it structurally.
 */

export interface ConnectionScope {
  readonly tenantId: string;
  readonly clientId: string;
}

export interface ConnectionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: string;
  readonly mode: string;
  readonly scopes: string[];
  readonly credentialRef: string | null;
  readonly writesEnabled: boolean;
  readonly healthy: boolean;
  readonly status: string;
  readonly statusCode: string | null;
  readonly statusChangedAt: Date | null;
  readonly connectedAt: Date | null;
  readonly connectedByUserId: string | null;
  readonly remoteCompanyName: string | null;
  readonly remoteOrganisationNumber: string | null;
  readonly lastCheckedAt: Date | null;
}

export interface CredentialRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: string;
  readonly sealedAccessToken: string | null;
  readonly sealedRefreshToken: string;
  readonly accessTokenExpiresAt: Date | null;
  readonly refreshTokenExpiresAt: Date | null;
  readonly grantedScopes: string[];
  readonly refreshTokenFingerprint: string;
  readonly rotationCount: number;
  readonly rotatedAt: Date | null;
}

export interface AuthorizationRequestRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly provider: string;
  readonly stateHash: string;
  readonly redirectUri: string;
  readonly requestedScopes: string[];
  readonly initiatedByUserId: string;
  readonly returnTo: string | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface FortnoxConnectionStore {
  getIntegrationConnection(
    scope: ConnectionScope,
    kind?: string,
  ): Promise<ConnectionRecord | undefined>;

  upsertIntegrationConnection(input: {
    id?: string;
    tenantId: string;
    clientId: string;
    kind: string;
    mode: string;
    scopes: string[];
    credentialRef?: string | null;
    writesEnabled?: boolean;
    healthy?: boolean;
    status?: string;
    statusCode?: string | null;
    statusChangedAt?: Date | null;
    connectedAt?: Date | null;
    connectedByUserId?: string | null;
    remoteCompanyName?: string | null;
    remoteOrganisationNumber?: string | null;
    lastCheckedAt?: Date | null;
  }): Promise<ConnectionRecord>;

  updateIntegrationConnection(
    scope: ConnectionScope,
    kind: string,
    patch: Record<string, unknown>,
  ): Promise<void>;

  createAuthorizationRequest(input: {
    id?: string;
    tenantId: string;
    clientId: string;
    provider: string;
    stateHash: string;
    redirectUri: string;
    requestedScopes: string[];
    initiatedByUserId: string;
    returnTo?: string | null;
    expiresAt: Date;
  }): Promise<AuthorizationRequestRecord>;

  consumeAuthorizationRequest(
    stateHash: string,
    now?: Date,
  ): Promise<AuthorizationRequestRecord | undefined>;

  deleteExpiredAuthorizationRequests(now?: Date): Promise<void>;

  getIntegrationCredential(
    scope: ConnectionScope,
    kind: string,
  ): Promise<CredentialRecord | undefined>;

  upsertIntegrationCredential(input: {
    id?: string;
    tenantId: string;
    clientId: string;
    kind: string;
    sealedAccessToken?: string | null;
    sealedRefreshToken: string;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    grantedScopes: string[];
    refreshTokenFingerprint: string;
    rotationCount?: number;
    rotatedAt?: Date | null;
  }): Promise<CredentialRecord>;

  rotateIntegrationCredential(
    scope: ConnectionScope,
    kind: string,
    expectedRotationCount: number,
    patch: {
      sealedAccessToken: string;
      sealedRefreshToken: string;
      accessTokenExpiresAt: Date;
      refreshTokenExpiresAt: Date;
      grantedScopes: string[];
      refreshTokenFingerprint: string;
      rotatedAt: Date;
    },
  ): Promise<boolean>;

  deleteIntegrationCredential(scope: ConnectionScope, kind: string): Promise<void>;
}
