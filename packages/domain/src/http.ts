/**
 * Minimal structural types for the HTTP calls this system makes.
 *
 * Server-side packages here talk to Fortnox and OpenAI over `fetch`. Typing
 * those calls against the *ambient* `fetch`/`Response` globals makes them
 * depend on which typings a consumer's tsconfig happens to expose - DOM lib,
 * `@types/node` via `undici-types`, or neither. A Next.js app, an API server
 * and a test runner each answer that differently, and when the answer is wrong
 * the failure is a wall of "Property 'ok' does not exist on type 'Response'"
 * in a package the consumer does not even use.
 *
 * Declaring the small surface we actually touch removes that dependency: these
 * packages compile the same way under every configuration.
 */

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  /** A string body, or form-encoded parameters. */
  body?: unknown;
  signal?: unknown;
}

export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/**
 * Adapts whatever `fetch` implementation is in play to `HttpFetch`.
 *
 * The cast is the whole point of this module and is confined to it: at this one
 * boundary we accept that the real implementation is structurally compatible,
 * so that no other file has to care which global typings are loaded.
 */
export function asHttpFetch(impl: unknown): HttpFetch {
  return impl as HttpFetch;
}
