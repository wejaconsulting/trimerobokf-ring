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
  fortnoxAdapter: z.enum(['mock', 'real']).default('mock'),
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

  // Phase 1 refuses to start in a configuration that could write to Fortnox.
  if (config.fortnoxWritesEnabled) {
    throw new Error(
      'FORTNOX_WRITES_ENABLED=true is not supported in phase 1. Writes require a future ' +
        'feature flag, a recorded human approval and a policy check - see docs/shadow-mode.md.',
    );
  }
  if (config.fortnoxAdapter === 'real') {
    throw new Error(
      'FORTNOX_ADAPTER=real is not supported in phase 1. Only the mock adapter is wired up.',
    );
  }

  return config;
}

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
