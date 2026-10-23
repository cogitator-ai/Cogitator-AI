import { z } from 'zod';
import { FeedError, type FeedErrorCode, feedErrorCode, retryAfterOf } from '../../feeds/errors';
import type { TeamsCredentials } from './token';

/** The statuses Microsoft asks bots to retry with a backoff. */
const RETRIED = new Set([412, 429, 502, 504]);

export type TeamsMethod = 'POST' | 'PUT' | 'DELETE';

/** How failed requests are tried again: exponential backoff with jitter, or `Retry-After`. */
export interface TeamsRetryOptions {
  /** Tries after the first one (default 3) */
  retries?: number;
  /** The first wait, doubled on every try, in ms (default 500) */
  baseDelay?: number;
  /** The longest wait, in ms (default 10 000) */
  maxDelay?: number;
}

const ErrorBodySchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  message: z.string().optional(),
});

/**
 * A failed Bot Connector request, with the error code Teams gave, such as
 * `MessageWritesBlocked` when the user blocked the bot or removed the app.
 */
export class TeamsApiError extends FeedError {
  /** The Bot Connector error code, such as `MessageWritesBlocked` or `BadArgument` */
  readonly errorCode?: string;

  constructor(
    code: FeedErrorCode,
    message: string,
    options: { status?: number; retryAfter?: number; errorCode?: string; cause?: unknown }
  ) {
    super('teams', code, message, options);
    this.name = 'TeamsApiError';
    if (options.errorCode !== undefined) this.errorCode = options.errorCode;
  }
}

/** `value` without the slashes it ends with, in linear time. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TeamsClientOptions {
  credentials: TeamsCredentials;
  retry?: TeamsRetryOptions;
  fetch?: typeof fetch;
}

/** Calls the Bot Connector REST API of a service URL, retrying what Microsoft says to retry. */
export class TeamsClient {
  constructor(private readonly options: TeamsClientOptions) {}

  /** Sends one request, resolving with its parsed JSON body, or `undefined` for an empty one. */
  async request(
    method: TeamsMethod | 'GET',
    serviceUrl: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const retries = this.options.retry?.retries ?? 3;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(method, serviceUrl, path, body);
      } catch (error) {
        if (!(error instanceof FeedError)) throw error;
        if (error instanceof TeamsApiError && error.status === 401 && !refreshed) {
          refreshed = true;
          this.options.credentials.invalidate();
          attempt--;
          continue;
        }
        const retried =
          error.status === undefined ? error.code === 'unavailable' : RETRIED.has(error.status);
        if (!retried || attempt >= retries) throw error;
        await sleep(this.delay(attempt, error.retryAfter));
      }
    }
  }

  /** The wait before try `attempt + 1`: `Retry-After` when sent, otherwise doubling with jitter. */
  private delay(attempt: number, retryAfter: number | undefined): number {
    const max = this.options.retry?.maxDelay ?? 10_000;
    if (retryAfter !== undefined) return Math.min(retryAfter, max * 6);
    const base = this.options.retry?.baseDelay ?? 500;
    const ceiling = Math.min(max, base * 2 ** attempt);
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }

  private async once(
    method: TeamsMethod | 'GET',
    serviceUrl: string,
    path: string,
    body: unknown
  ): Promise<unknown> {
    const token = await this.options.credentials.token();
    const url = `${trimTrailingSlashes(serviceUrl)}${path}`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json; charset=utf-8' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new TeamsApiError('unavailable', `${method} ${path} failed: ${String(error)}`, {
        cause: error,
      });
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.ok) return parsed;
    const errorBody = ErrorBodySchema.safeParse(parsed);
    const errorCode = errorBody.success ? errorBody.data.error?.code : undefined;
    const detail = errorBody.success
      ? (errorBody.data.error?.message ?? errorBody.data.message)
      : text.slice(0, 300) || undefined;
    const retryAfter = retryAfterOf(response.headers);
    const blocked = errorCode === 'MessageWritesBlocked';
    const message = blocked
      ? `${method} ${path} failed: the conversation blocks the bot's messages (MessageWritesBlocked), the user blocked the bot or removed the app`
      : `${method} ${path} failed: ${[errorCode, detail].filter(Boolean).join(': ') || `HTTP ${response.status}`}`;
    throw new TeamsApiError(
      response.status === 412 ? 'rate_limited' : feedErrorCode(response.status),
      message,
      {
        status: response.status,
        ...(retryAfter !== undefined && { retryAfter }),
        ...(errorCode !== undefined && { errorCode }),
        cause: parsed ?? text,
      }
    );
  }
}
