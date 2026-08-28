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
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = appConfigSchema.parse({
    apiHost: env.API_HOST,
    apiPort: env.API_PORT,
    logLevel: env.LOG_LEVEL,
    shadowMode: env.SHADOW_MODE,
    fortnoxWritesEnabled: env.FORTNOX_WRITES_ENABLED,
    fortnoxAdapter: env.FORTNOX_ADAPTER ?? 'mock',
    fortnoxApiBaseUrl: env.FORTNOX_API_BASE_URL,
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
