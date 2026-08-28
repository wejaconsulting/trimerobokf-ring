import { withRetry } from './retry.js';
import {
  ModelOutputValidationError,
  ModelProviderError,
  type ModelProvider,
  type StructuredRequest,
  type StructuredResult,
} from './types.js';

/**
 * Optional OpenAI provider, built on the Responses API.
 *
 * Implemented with `fetch` rather than the SDK so the package has no hard
 * dependency and the project installs and tests with no AI key present.
 * Swapping in the Agents SDK is a change inside this class only - the
 * `ModelProvider` interface is what the rest of the system depends on.
 *
 * The API key is read once at construction, is never logged, and never appears
 * in an audit event or a prompt.
 */

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-1M-token prices, used only for the cost estimate in the audit log. */
  readonly pricing?: { readonly inputPerMillion: number; readonly outputPerMillion: number };
}

interface ResponsesApiResult {
  output_text?: string;
  output?: {
    type: string;
    content?: { type: string; text?: string }[];
    name?: string;
    arguments?: string;
  }[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

export class OpenAIModelProvider implements ModelProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pricing: { inputPerMillion: number; outputPerMillion: number };

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAIModelProvider requires an API key. Set MODEL_PROVIDER=fake to run offline.');
    }
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.#baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.#fetch = options.fetchImpl ?? fetch;
    this.#pricing = options.pricing ?? { inputPerMillion: 0, outputPerMillion: 0 };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();

    const body = {
      model: this.model,
      instructions: request.prompt.system,
      input: request.prompt.render(request.input),
      text: {
        format: {
          type: 'json_schema',
          name: request.prompt.id,
          strict: true,
          schema: request.jsonSchema,
        },
      },
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
    };

    const { value: result, attempts } = await withRetry(
      async (signal) => {
        const response = await this.#fetch(`${this.#baseUrl}/responses`, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.#apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          // 408/409/429 and 5xx are transient; 4xx otherwise means the request
          // itself is wrong and retrying would only cost money.
          const retryable =
            response.status === 408 ||
            response.status === 409 ||
            response.status === 429 ||
            response.status >= 500;
          throw new ModelProviderError(
            `OpenAI responded ${response.status}: ${text.slice(0, 300)}`,
            { retryable },
          );
        }

        return (await response.json()) as ResponsesApiResult;
      },
      {
        maxRetries: request.maxRetries ?? 2,
        timeoutMs: request.timeoutMs ?? 30_000,
      },
    );

    const text = extractText(result);
    if (!text) {
      throw new ModelProviderError('OpenAI returned no structured output.', { retryable: false });
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new ModelOutputValidationError([`response was not valid JSON: ${String(error)}`]);
    }

    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new ModelOutputValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }

    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;

    return {
      data: parsed.data,
      provider: this.name,
      model: this.model,
      promptId: request.prompt.id,
      promptVersion: request.prompt.version,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: result.usage?.total_tokens ?? inputTokens + outputTokens,
        estimatedCostUsd:
          (inputTokens / 1_000_000) * this.#pricing.inputPerMillion +
          (outputTokens / 1_000_000) * this.#pricing.outputPerMillion,
      },
      latencyMs: Date.now() - started,
      attempts,
      requestedToolCalls: extractToolCalls(result),
    };
  }
}

function extractText(result: ResponsesApiResult): string | null {
  if (result.output_text) return result.output_text;
  for (const item of result.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text) return content.text;
    }
  }
  return null;
}

function extractToolCalls(result: ResponsesApiResult): { name: string; arguments: unknown }[] {
  const calls: { name: string; arguments: unknown }[] = [];
  for (const item of result.output ?? []) {
    if (item.type !== 'function_call' || !item.name) continue;
    let args: unknown = item.arguments;
    try {
      if (typeof item.arguments === 'string') args = JSON.parse(item.arguments);
    } catch {
      // Keep the raw string: an unparseable argument list is itself a finding
      // for whoever reviews the audit log.
    }
    calls.push({ name: item.name, arguments: args });
  }
  return calls;
}
