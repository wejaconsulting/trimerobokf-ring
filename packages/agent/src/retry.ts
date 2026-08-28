import { ModelProviderError } from './types.js';

export interface RetryOptions {
  readonly maxRetries: number;
  readonly timeoutMs: number;
  /** Base delay; each attempt waits base * 2^attempt with full jitter. */
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs an operation with a per-attempt timeout and bounded exponential backoff.
 *
 * Only errors explicitly marked retryable are retried: a schema validation
 * failure or a 400 from the provider is a bug in the prompt, and retrying it
 * just burns tokens.
 */
export async function withRetry<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = options.baseDelayMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const value = await operation(controller.signal);
      return { value, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ModelProviderError
          ? error.retryable
          : error instanceof Error && error.name === 'AbortError';
      if (!retryable || attempt === options.maxRetries) break;
      await sleep(Math.round(Math.random() * base * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ModelProviderError('Model call failed', { retryable: false, cause: lastError });
}
