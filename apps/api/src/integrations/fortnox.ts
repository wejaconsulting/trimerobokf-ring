import type { Repositories } from '@trimeros/db';
import {
  FORTNOX_CONNECTION_KIND,
  FORTNOX_DATA_SOURCE_KIND,
  FORTNOX_READ_SCOPES,
  FortnoxConnectionService,
  FortnoxTokenClient,
  RealFortnoxAdapter,
  loadEncryptionKey,
  mockDataSource,
  unavailableDataSource,
  type FortnoxDataSource,
  type FortnoxPortResolver,
  type MockFortnoxAdapter,
} from '@trimeros/fortnox';
import type { AppConfig } from '../config.js';

/**
 * Builds the Fortnox connection service, or explains why it cannot be built.
 *
 * The integration is optional. With no client credentials configured the app
 * runs exactly as before on synthetic data, and the settings page says what is
 * missing instead of offering a button that would fail. That is the difference
 * between "not set up yet" and "broken", and Marcus should never have to tell
 * them apart.
 */

export const FORTNOX_CALLBACK_PATH = '/api/integrations/fortnox/callback';

export type FortnoxIntegration =
  | {
      readonly configured: true;
      readonly service: FortnoxConnectionService;
      readonly redirectUri: string;
    }
  | { readonly configured: false; readonly missing: readonly string[] };

export function describeMissingConfig(config: AppConfig): string[] {
  const missing: string[] = [];
  if (!config.fortnoxClientId) missing.push('FORTNOX_CLIENT_ID');
  if (!config.fortnoxClientSecret) missing.push('FORTNOX_CLIENT_SECRET');
  if (!config.fortnoxTokenEncryptionKey) missing.push('FORTNOX_TOKEN_ENCRYPTION_KEY');
  if (!config.apiPublicUrl) missing.push('API_PUBLIC_URL');
  return missing;
}

export function redirectUriFor(config: AppConfig): string {
  return `${config.apiPublicUrl.replace(/\/+$/, '')}${FORTNOX_CALLBACK_PATH}`;
}

export function createFortnoxIntegration(config: AppConfig, repos: Repositories): FortnoxIntegration {
  const missing = describeMissingConfig(config);
  if (missing.length > 0) return { configured: false, missing };

  // Throws on a malformed key rather than starting with token storage that
  // would fail at the worst moment - the middle of Marcus's setup.
  const encryptionKey = loadEncryptionKey(config.fortnoxTokenEncryptionKey);

  const service = new FortnoxConnectionService({
    store: repos,
    tokenClient: new FortnoxTokenClient({
      clientId: config.fortnoxClientId,
      clientSecret: config.fortnoxClientSecret,
      ...(config.fortnoxTokenUrl ? { tokenUrl: config.fortnoxTokenUrl } : {}),
      ...(config.fortnoxRevokeUrl ? { revokeUrl: config.fortnoxRevokeUrl } : {}),
    }),
    encryptionKey,
    clientId: config.fortnoxClientId,
    ...(config.fortnoxAuthorizeUrl ? { authorizeUrl: config.fortnoxAuthorizeUrl } : {}),
    apiBaseUrl: config.fortnoxApiBaseUrl,
    scopes: FORTNOX_READ_SCOPES,
  });

  return { configured: true, service, redirectUri: redirectUriFor(config) };
}

export interface ResolverDependencies {
  readonly config: AppConfig;
  readonly repos: Repositories;
  readonly integration: FortnoxIntegration;
  readonly mock: MockFortnoxAdapter;
}

/**
 * Decides, per client and per run, where the data comes from.
 *
 * The decision table, in order:
 *  1. `FORTNOX_ADAPTER` is `real` or `auto`, the OAuth integration is
 *     configured and the client holds a *connected* grant → a fresh
 *     `RealFortnoxAdapter` whose token provider is the connection service.
 *     Writes are enabled on it only when the global switches passed
 *     `appConfigFromEnv` AND the client's own connection row says so.
 *  2. `FORTNOX_ADAPTER` is `mock` or `auto` and the client holds the demo-data
 *     row → the shared mock adapter.
 *  3. Otherwise → no data source, with the reason the readiness step reports.
 */
export function createFortnoxResolver(deps: ResolverDependencies): FortnoxPortResolver {
  const { config, repos, integration, mock } = deps;
  return {
    async resolve(scope): Promise<FortnoxDataSource> {
      if (config.fortnoxAdapter !== 'mock' && integration.configured) {
        const grant = await repos.getIntegrationConnection(scope, FORTNOX_CONNECTION_KIND);
        if (grant && grant.status === 'connected') {
          const service = integration.service;
          const port = new RealFortnoxAdapter({
            baseUrl: config.fortnoxApiBaseUrl,
            tokenProvider: { getAccessToken: () => service.getAccessToken(scope) },
            writesEnabled: config.fortnoxWritesEnabled && !config.shadowMode && grant.writesEnabled,
            shadowMode: config.shadowMode,
          });
          return {
            kind: 'real',
            port,
            label: grant.remoteCompanyName
              ? `${grant.remoteCompanyName}${grant.remoteOrganisationNumber ? ` · ${grant.remoteOrganisationNumber}` : ''}`
              : 'Fortnox',
            reason: null,
          };
        }
      }

      if (config.fortnoxAdapter !== 'real') {
        const demo = await repos.getIntegrationConnection(scope, FORTNOX_DATA_SOURCE_KIND);
        if (demo && demo.mode === 'mock') return mockDataSource(mock);
      }

      if (!integration.configured) {
        return unavailableDataSource(
          'Klienten har ingen datakälla. Fortnox-integrationen är inte konfigurerad på servern (' +
            (integration.configured ? '' : integration.missing.join(', ')) +
            ') och klienten saknar demodata.',
        );
      }
      return unavailableDataSource(
        config.fortnoxAdapter === 'real'
          ? 'Klienten är inte ansluten till Fortnox. Anslut den under Inställningar → Fortnox.'
          : 'Klienten har varken en Fortnox-anslutning eller demodata. Anslut den under Inställningar → Fortnox.',
      );
    },
  };
}
