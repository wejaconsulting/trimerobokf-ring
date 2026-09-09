import {
  FORTNOX_READ_SCOPES,
  FortnoxConnectionService,
  FortnoxTokenClient,
  loadEncryptionKey,
} from '@trimeros/fortnox';
import type { AppConfig } from '../config.js';
import type { Runtime } from '../runtime.js';

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

export function createFortnoxIntegration(runtime: Runtime): FortnoxIntegration {
  const { config, repos } = runtime;
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
