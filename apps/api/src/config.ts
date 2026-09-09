import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * The three safety switches are parsed strictly and default to the safe value.
 * A typo in `SHADOW_MODE` therefore leaves shadow mode ON rather than turning
 * it off, which is the only acceptable direction for that mistake.
 */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v.toLowerCase() === 'true'));

export const appConfigSchema = z.object({
  apiHost: z.string().default('127.0.0.1'),
  apiPort: z.coerce.number().int().min(1).max(65535).default(4000),
  logLevel: z.string().default('info'),
  shadowMode: boolFromEnv(true),
  fortnoxWritesEnabled: boolFromEnv(false),
  /**
   * Which data source a client's close run reads from.
   *  - `mock`: synthetic demo data for every client (the default; tests).
   *  - `auto`: a real, read-only Fortnox adapter for clients with a live OAuth
   *    connection, demo data for clients that only have the demo row.
   *  - `real`: only live connections count; an unconnected client is blocked.
   */
  fortnoxAdapter: z.enum(['mock', 'real', 'auto']).default('mock'),
  /** Must equal FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE for writes to be enabled. */
  fortnoxWritesAcknowledgement: z.string().default(''),
  fortnoxApiBaseUrl: z.string().default('https://api.fortnox.se'),
  /**
   * OAuth client credentials for the registered Fortnox app.
   *
   * These never leave the API process: they are used to sign the token request
   * and are absent from every response, log line and audit event. The review
   * app is only ever told whether they are set.
   */
  fortnoxClientId: z.string().default(''),
  fortnoxClientSecret: z.string().default(''),
  /** Base64 32-byte key that seals stored tokens. No key, no token storage. */
  fortnoxTokenEncryptionKey: z.string().default(''),
  fortnoxAuthorizeUrl: z.string().optional(),
  fortnoxTokenUrl: z.string().optional(),
  fortnoxRevokeUrl: z.string().optional(),
  /**
   * The API's own public base URL. The OAuth redirect URI is derived from it
   * and must match what is registered on the Fortnox app, character for
   * character - a mismatch is the single most common setup failure.
   */
  apiPublicUrl: z.string().default(''),
  /** Where the browser is sent after the callback finishes. */
  webBaseUrl: z.string().default(''),
  /** Origins allowed to call the API. Empty means "reflect any origin". */
  corsOrigins: z.array(z.string()).default([]),
  /** When a password is set, every route except /health requires basic auth. */
  demoUser: z.string().default('demo'),
  demoPassword: z.string().default(''),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = appConfigSchema.parse({
    apiHost: resolveHost(env),
    apiPort: env.PORT ?? env.API_PORT,
    logLevel: env.LOG_LEVEL,
    shadowMode: env.SHADOW_MODE,
    fortnoxWritesEnabled: env.FORTNOX_WRITES_ENABLED,
    fortnoxAdapter: env.FORTNOX_ADAPTER ?? 'mock',
    fortnoxWritesAcknowledgement: env.FORTNOX_WRITES_ACKNOWLEDGEMENT,
    fortnoxApiBaseUrl: env.FORTNOX_API_BASE_URL,
    fortnoxClientId: env.FORTNOX_CLIENT_ID,
    fortnoxClientSecret: env.FORTNOX_CLIENT_SECRET,
    fortnoxTokenEncryptionKey: env.FORTNOX_TOKEN_ENCRYPTION_KEY,
    fortnoxAuthorizeUrl: env.FORTNOX_AUTHORIZE_URL,
    fortnoxTokenUrl: env.FORTNOX_TOKEN_URL,
    fortnoxRevokeUrl: env.FORTNOX_REVOKE_URL,
    apiPublicUrl: env.API_PUBLIC_URL,
    webBaseUrl: env.WEB_BASE_URL,
    corsOrigins: (env.WEB_ORIGIN ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    demoUser: env.DEMO_USER,
    demoPassword: env.DEMO_PASSWORD,
  });

  // Writing to Fortnox is never one flag. The process refuses to start unless
  // shadow mode is off AND the operator has typed the acknowledgement phrase,
  // and even then every single write still has to pass the seven-condition
  // gate in packages/fortnox/src/write-policy.ts.
  if (config.fortnoxWritesEnabled) {
    if (config.shadowMode) {
      throw new Error(
        'FORTNOX_WRITES_ENABLED=true requires SHADOW_MODE=false. Shadow mode blocks every write, ' +
          'so this combination is a misconfiguration - see docs/shadow-mode.md.',
      );
    }
    if (config.fortnoxWritesAcknowledgement !== FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE) {
      throw new Error(
        'FORTNOX_WRITES_ENABLED=true requires FORTNOX_WRITES_ACKNOWLEDGEMENT to be set to the exact ' +
          `phrase "${FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE}" - see docs/shadow-mode.md.`,
      );
    }
    if (config.fortnoxAdapter === 'mock') {
      throw new Error(
        'FORTNOX_WRITES_ENABLED=true is meaningless with FORTNOX_ADAPTER=mock: the mock adapter never writes.',
      );
    }
  }

  return config;
}

/**
 * The sentence an operator has to put in the environment to enable writes.
 * Swedish on purpose: the person flipping this switch is the accounting firm.
 */
export const FORTNOX_WRITES_ACKNOWLEDGEMENT_PHRASE =
  'JAG FÖRSTÅR ATT DETTA BOKFÖR PÅ RIKTIGT I KLIENTERNAS FORTNOX';

/**
 * Picks the bind address.
 *
 * Hosting platforms (Render, Railway, Fly) inject `PORT` and route traffic to
 * the container, so a process still bound to loopback is simply unreachable -
 * and the failure looks like a health-check timeout rather than a config
 * mistake. When `PORT` is present and `API_HOST` is not, bind all interfaces.
 * Locally, where neither is set, keep loopback: an API with no authentication
 * should not be exposed to the local network by default.
 */
function resolveHost(env: NodeJS.ProcessEnv): string | undefined {
  if (env.API_HOST) return env.API_HOST;
  return env.PORT ? '0.0.0.0' : undefined;
}
