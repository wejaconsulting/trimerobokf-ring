import { FakeModelProvider } from './fake-provider.js';
import { OpenAIModelProvider } from './openai-provider.js';
import type { ModelProvider } from './types.js';

export interface ModelProviderConfig {
  readonly provider: 'fake' | 'openai';
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProviderConfig {
  const provider = env.MODEL_PROVIDER === 'openai' ? 'openai' : 'fake';
  return {
    provider,
    model: env.MODEL_NAME ?? (provider === 'openai' ? 'gpt-4.1-mini' : 'fake-deterministic-v1'),
    apiKey: env.OPENAI_API_KEY,
    timeoutMs: Number(env.MODEL_TIMEOUT_MS ?? 30_000),
    maxRetries: Number(env.MODEL_MAX_RETRIES ?? 2),
  };
}

/**
 * Chooses a provider.
 *
 * Defaults to the fake provider, including when `openai` is requested without a
 * key: the system degrades to deterministic output rather than failing a close
 * run, and says so in the returned provider's name.
 */
export function createModelProvider(config: ModelProviderConfig): ModelProvider {
  if (config.provider === 'openai' && config.apiKey) {
    return new OpenAIModelProvider({ apiKey: config.apiKey, model: config.model });
  }
  return new FakeModelProvider(config.provider === 'openai' ? 'fake-fallback-no-api-key' : config.model);
}
