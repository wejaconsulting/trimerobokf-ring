import { asHttpFetch, type HttpFetch, type HttpResponse } from '@trimeros/domain';
import type { ZodType } from 'zod';
import { FORTNOX_RATE_LIMIT, SlidingWindowRateLimiter } from './rate-limiter.js';

/**
 * The HTTP client every real Fortnox call goes through.
 *
 * Responsibilities, and nothing else:
 *  - attach a bearer token obtained from the injected provider, per request,
 *    so a token refreshed mid-run is picked up automatically;
 *  - respect the documented rate limit and back off on 429/5xx;
 *  - paginate list resources;
 *  - parse every response through a schema, so a field Fortnox renames shows
 *    up as a typed error at the boundary rather than as `undefined` deep in a
 *    rule.
 *
 * Security: the token is a local variable inside `#send`. It is never part of
 * an error, a log line or a returned object, and `FortnoxApiError` carries the
 * request path and Fortnox's own error code only.
 */

export interface AccessTokenProvider {
  /** Returns a bearer token. Implementations must not log or persist it. */
  getAccessToken(): Promise<string>;
}

export interface FortnoxHttpClientOptions {
  readonly baseUrl: string;
  readonly tokenProvider: AccessTokenProvider;
  readonly fetchImpl?: HttpFetch;
  readonly timeoutMs?: number;
  /** Retries on 429 and 5xx. Never applied to non-idempotent calls. */
  readonly maxRetries?: number;
  readonly rateLimiter?: SlidingWindowRateLimiter;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type FortnoxQuery = Record<string, string | number | undefined>;

export class FortnoxApiError extends Error {
  override readonly name = 'FortnoxApiError';
  readonly status: number;
  readonly path: string;
  /** Fortnox's numeric error code from `ErrorInformation.Code`, when present. */
  readonly fortnoxCode: number | null;
  readonly fortnoxMessage: string | null;

  constructor(input: {
    status: number;
    path: string;
    fortnoxCode?: number | null;
    fortnoxMessage?: string | null;
  }) {
    super(
      `Fortnox ${input.status} on ${input.path}` +
        (input.fortnoxMessage ? `: ${input.fortnoxMessage}` : '') +
        (input.fortnoxCode ? ` (code ${input.fortnoxCode})` : ''),
    );
    this.status = input.status;
    this.path = input.path;
    this.fortnoxCode = input.fortnoxCode ?? null;
    this.fortnoxMessage = input.fortnoxMessage ?? null;
  }

  /** 401 means the grant is gone; the caller should mark the connection. */
  get requiresReconnect(): boolean {
    return this.status === 401;
  }
}

export class FortnoxResponseShapeError extends Error {
  override readonly name = 'FortnoxResponseShapeError';
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`Fortnox response for ${path} did not match the expected shape: ${detail}`);
    this.path = path;
  }
}

/** Fortnox's documented maximum page size. */
export const FORTNOX_MAX_PAGE_SIZE = 500;

interface MetaInformation {
  readonly '@TotalPages'?: number;
  readonly '@CurrentPage'?: number;
  readonly '@TotalResources'?: number;
}

export class FortnoxHttpClient {
  readonly #options: FortnoxHttpClientOptions;
  readonly #limiter: SlidingWindowRateLimiter;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: FortnoxHttpClientOptions) {
    this.#options = options;
    this.#limiter = options.rateLimiter ?? new SlidingWindowRateLimiter(FORTNOX_RATE_LIMIT);
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET one resource and parse it. */
  async get<T>(path: string, query: FortnoxQuery, schema: ZodType<T>): Promise<T> {
    const body = await this.#send('GET', withQuery(path, query), null, true);
    return parseWith(schema, body, path);
  }

  /**
   * GET every page of a list resource.
   *
   * Fortnox paginates with `page` and `limit` and reports `@TotalPages` in
   * `MetaInformation`. Pages are fetched sequentially: the rate limiter makes
   * parallel pages pointless, and sequential is simpler to reason about when
   * a page fails midway.
   */
  async list<T>(
    path: string,
    query: FortnoxQuery,
    wrapperKey: string,
    itemSchema: ZodType<T>,
  ): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const body = (await this.#send(
        'GET',
        withQuery(path, { ...query, page, limit: FORTNOX_MAX_PAGE_SIZE }),
        null,
        true,
      )) as Record<string, unknown>;
      const items = body[wrapperKey];
      if (items !== undefined && !Array.isArray(items)) {
        throw new FortnoxResponseShapeError(path, `"${wrapperKey}" is not an array`);
      }
      for (const item of (items ?? []) as unknown[]) {
        out.push(parseWith(itemSchema, item, path));
      }
      const meta = (body.MetaInformation ?? {}) as MetaInformation;
      const totalPages = meta['@TotalPages'] ?? 1;
      if (page >= totalPages) return out;
      page += 1;
    }
  }

  /** POST a JSON body. Never retried: a create is not idempotent. */
  async post<T>(path: string, query: FortnoxQuery, body: unknown, schema: ZodType<T>): Promise<T> {
    const response = await this.#send('POST', withQuery(path, query), body, false);
    return parseWith(schema, response, path);
  }

  async #send(method: 'GET' | 'POST', path: string, body: unknown, retryable: boolean): Promise<unknown> {
    const maxRetries = retryable ? (this.#options.maxRetries ?? 3) : 0;
    let attempt = 0;
    for (;;) {
      await this.#limiter.acquire();
      const response = await this.#once(method, path, body);

      if (response.ok) {
        const text = await response.text();
        if (text.trim() === '') return {};
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new FortnoxResponseShapeError(path, 'body is not JSON');
        }
      }

      const error = await toApiError(response, path);
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt >= maxRetries) throw error;
      attempt += 1;
      // Fortnox's window is 5 s; a linear back-off inside it is enough.
      await this.#sleep(1_000 * attempt);
    }
  }

  async #once(method: 'GET' | 'POST', path: string, body: unknown): Promise<HttpResponse> {
    const token = await this.#options.tokenProvider.getAccessToken();
    const fetchImpl = this.#options.fetchImpl ?? asHttpFetch(globalThis.fetch);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 30_000);
    try {
      return await fetchImpl(`${this.#options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // Re-thrown without the request headers: the message names the path only.
      throw new FortnoxApiError({
        status: 0,
        path,
        fortnoxMessage: controller.signal.aborted
          ? 'request timed out'
          : `transport failure: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function withQuery(path: string, query: FortnoxQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function parseWith<T>(schema: ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  throw new FortnoxResponseShapeError(
    path,
    first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'unknown issue',
  );
}

async function toApiError(response: HttpResponse, path: string): Promise<FortnoxApiError> {
  let code: number | null = null;
  let message: string | null = null;
  try {
    const parsed = JSON.parse(await response.text()) as {
      ErrorInformation?: { Code?: unknown; Message?: unknown; message?: unknown; code?: unknown };
    };
    const info = parsed.ErrorInformation ?? {};
    const rawCode = info.Code ?? info.code;
    const rawMessage = info.Message ?? info.message;
    code = typeof rawCode === 'number' ? rawCode : null;
    message = typeof rawMessage === 'string' ? rawMessage.slice(0, 200) : null;
  } catch {
    // A non-JSON error body carries nothing worth keeping.
  }
  return new FortnoxApiError({ status: response.status, path, fortnoxCode: code, fortnoxMessage: message });
}
