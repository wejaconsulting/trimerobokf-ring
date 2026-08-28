import type { z } from 'zod';

/**
 * The model boundary.
 *
 * A provider receives a versioned prompt and a already-sanitised input object,
 * and must return data that validates against a schema. It is given no database
 * handle, no Fortnox adapter and no credentials - everything it can see was
 * chosen explicitly by the caller. See docs/security-and-permissions.md.
 */

export interface PromptTemplate {
  readonly id: string;
  /** Bumped whenever the wording changes; stamped on every audit event. */
  readonly version: string;
  readonly system: string;
  /** Renders the user message from the (already redacted) input. */
  render(input: Readonly<Record<string, unknown>>): string;
}

/**
 * A tool the model may request.
 *
 * Tools are declarative only: the host decides whether to execute one, and the
 * allowlist below is the entire surface. No tool in phase 1 reaches Fortnox or
 * the database.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Read-only tools may be executed automatically; others need a human. */
  readonly readOnly: boolean;
}

export interface StructuredRequest<T> {
  readonly prompt: PromptTemplate;
  readonly input: Readonly<Record<string, unknown>>;
  readonly schema: z.ZodType<T>;
  /** JSON Schema handed to the provider for structured output. */
  readonly jsonSchema: Record<string, unknown>;
  readonly tools?: readonly ToolDefinition[];
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Correlates the call with the close run in the audit log. */
  readonly correlationId: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Best-effort cost estimate in USD; 0 for the fake provider. */
  readonly estimatedCostUsd: number;
}

export interface StructuredResult<T> {
  readonly data: T;
  readonly provider: string;
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  readonly attempts: number;
  /** Tool calls the model requested. Never auto-executed in phase 1. */
  readonly requestedToolCalls: readonly { readonly name: string; readonly arguments: unknown }[];
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class ModelProviderError extends Error {
  override readonly name = 'ModelProviderError';
  readonly retryable: boolean;
  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.retryable = options.retryable;
  }
}

export class ModelOutputValidationError extends Error {
  override readonly name = 'ModelOutputValidationError';
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Model output failed schema validation: ${issues.join('; ')}`);
    this.issues = issues;
  }
}
