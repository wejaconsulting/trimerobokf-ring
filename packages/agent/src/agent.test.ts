import { asHttpFetch } from '@trimeros/domain';
import { describe, expect, it, vi } from 'vitest';
import { createModelProvider, modelConfigFromEnv } from './factory.js';
import { FakeModelProvider } from './fake-provider.js';
import { OpenAIModelProvider } from './openai-provider.js';
import { ACCOUNTANT_REPORT_PROMPT, ALLOWED_TOOLS, accountantReportJsonSchema, accountantReportSchema } from './prompts.js';
import { withRetry } from './retry.js';
import { ModelOutputValidationError, ModelProviderError } from './types.js';

const request = {
  prompt: ACCOUNTANT_REPORT_PROMPT,
  input: {
    clientName: 'Nordvik Konsult AB',
    period: '2025-08',
    totalFindings: 20,
    blockingFindings: 8,
    reviewFindings: 7,
    manualFindings: 13,
    clearItems: 5,
    notImplementedSteps: [{ labelSv: 'Balansavstämningar' }],
    topFindings: [{ description: 'Saknat underlag', severity: 'high', rationale: 'Ingen fil kopplad.' }],
    blockers: ['Saknat underlag'],
  },
  schema: accountantReportSchema,
  jsonSchema: accountantReportJsonSchema,
  correlationId: 'corr-1',
};

describe('fake model provider', () => {
  it('produces schema-valid output with no API key', async () => {
    const result = await new FakeModelProvider().generateStructured(request);
    expect(result.data.headline).toContain('Nordvik Konsult AB');
    expect(result.data.summary).toContain('8 avvikelse(r) blockerar perioden');
    expect(result.provider).toBe('fake');
    expect(result.usage.estimatedCostUsd).toBe(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('is deterministic', async () => {
    const provider = new FakeModelProvider();
    const a = await provider.generateStructured(request);
    const b = await provider.generateStructured(request);
    expect(a.data).toEqual(b.data);
  });

  it('never claims a period is complete when blockers remain', async () => {
    const result = await new FakeModelProvider().generateStructured(request);
    expect(result.data.summary).not.toMatch(/perioden är komplett/i);
    expect(result.data.blockers.length).toBeGreaterThan(0);
  });

  it('reports zero tool calls: the model executes nothing itself', async () => {
    const result = await new FakeModelProvider().generateStructured({ ...request, tools: ALLOWED_TOOLS });
    expect(result.requestedToolCalls).toEqual([]);
  });
});

describe('prompt registry', () => {
  it('stamps an immutable version on every prompt', () => {
    expect(ACCOUNTANT_REPORT_PROMPT.version).toBe('accountant_report@1.0.0');
  });

  it('carries guardrails forbidding the model from deciding', () => {
    expect(ACCOUNTANT_REPORT_PROMPT.system).toContain('fattar aldrig bokföringsbeslut');
    expect(ACCOUNTANT_REPORT_PROMPT.system).toContain('aldrig påstå att en period är klar');
  });

  it('exposes only read-only tools', () => {
    expect(ALLOWED_TOOLS.length).toBeGreaterThan(0);
    for (const tool of ALLOWED_TOOLS) expect(tool.readOnly).toBe(true);
    const names = ALLOWED_TOOLS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/fortnox|write|sql|query|book/i);
  });
});

describe('retry policy', () => {
  it('retries retryable failures and then succeeds', async () => {
    let attempts = 0;
    const { value, attempts: used } = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new ModelProviderError('rate limited', { retryable: true });
        return 'ok';
      },
      { maxRetries: 3, timeoutMs: 1000, baseDelayMs: 1 },
    );
    expect(value).toBe('ok');
    expect(used).toBe(3);
  });

  it('does not retry a non-retryable failure', async () => {
    const operation = vi.fn(async () => {
      throw new ModelProviderError('bad request', { retryable: false });
    });
    await expect(
      withRetry(operation, { maxRetries: 3, timeoutMs: 1000, baseDelayMs: 1 }),
    ).rejects.toThrow('bad request');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries', async () => {
    const operation = vi.fn(async () => {
      throw new ModelProviderError('always down', { retryable: true });
    });
    await expect(
      withRetry(operation, { maxRetries: 2, timeoutMs: 1000, baseDelayMs: 1 }),
    ).rejects.toThrow('always down');
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('openai provider', () => {
  const options = {
    apiKey: 'sk-test-not-a-real-key',
    model: 'gpt-4.1-mini',
    pricing: { inputPerMillion: 1, outputPerMillion: 4 },
  };

  it('requires an API key', () => {
    expect(() => new OpenAIModelProvider({ apiKey: '', model: 'x' })).toThrow(/API key/);
  });

  it('parses a Responses API result and records usage', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            headline: 'h',
            summary: 's',
            riskAreas: [],
            recommendedActions: [],
            blockers: [],
          }),
          usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const provider = new OpenAIModelProvider({ ...options, fetchImpl: asHttpFetch(fetchImpl) });
    const result = await provider.generateStructured(request);

    expect(result.data.headline).toBe('h');
    expect(result.usage.totalTokens).toBe(1500);
    expect(result.usage.estimatedCostUsd).toBeCloseTo(1000 / 1e6 + (500 / 1e6) * 4, 10);
  });

  it('rejects output that does not match the schema', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ output_text: '{"headline":123}' }), { status: 200 }),
    );
    const provider = new OpenAIModelProvider({ ...options, fetchImpl: asHttpFetch(fetchImpl) });
    await expect(provider.generateStructured(request)).rejects.toBeInstanceOf(ModelOutputValidationError);
  });

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    const provider = new OpenAIModelProvider({ ...options, fetchImpl: asHttpFetch(fetchImpl) });
    await expect(
      provider.generateStructured({ ...request, maxRetries: 2, timeoutMs: 500 }),
    ).rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never places the API key anywhere but the Authorization header', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              headline: 'h',
              summary: 's',
              riskAreas: [],
              recommendedActions: [],
              blockers: [],
            }),
          }),
          { status: 200 },
        ),
    );
    const provider = new OpenAIModelProvider({ ...options, fetchImpl: asHttpFetch(fetchImpl) });
    await provider.generateStructured(request);

    const init = fetchImpl.mock.calls[0]?.[1] as { body?: string } | undefined;
    expect(init).toBeDefined();
    expect(String(init?.body)).not.toContain(options.apiKey);
  });
});

describe('provider factory', () => {
  it('defaults to the fake provider', () => {
    expect(createModelProvider(modelConfigFromEnv({})).name).toBe('fake');
  });

  it('falls back to fake when openai is requested without a key', () => {
    const provider = createModelProvider(modelConfigFromEnv({ MODEL_PROVIDER: 'openai' }));
    expect(provider.name).toBe('fake');
    expect(provider.model).toBe('fake-fallback-no-api-key');
  });

  it('uses openai when a key is present', () => {
    const provider = createModelProvider(
      modelConfigFromEnv({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x', MODEL_NAME: 'gpt-4.1-mini' }),
    );
    expect(provider.name).toBe('openai');
  });
});
