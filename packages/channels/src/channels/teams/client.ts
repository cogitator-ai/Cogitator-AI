import { z } from 'zod';
import { FeedError, type FeedErrorCode, feedErrorCode, retryAfterOf } from '../../feeds/errors';
import { pause, type ConversationPacer, type Priority } from './pacer';
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
  /** Whether the request got no answer in time */
  readonly timedOut: boolean;

  constructor(
    code: FeedErrorCode,
    message: string,
    options: {
      status?: number;
      retryAfter?: number;
      errorCode?: string;
      timedOut?: boolean;
      cause?: unknown;
    }
  ) {
    super('teams', code, message, options);
    this.name = 'TeamsApiError';
    this.timedOut = options.timedOut === true;
    if (options.errorCode !== undefined) this.errorCode = options.errorCode;
  }
}

/** `value` without the slashes it ends with, in linear time. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export interface TeamsClientOptions {
  credentials: TeamsCredentials;
  retry?: TeamsRetryOptions;
  /** How long one request may take, in ms (default 30 000) */
  timeout?: number;
  pacer?: ConversationPacer;
  fetch?: typeof fetch;
}

/** The conversation a request counts against, and whether it may wait behind new messages. */
export interface TeamsPacing {
  key: string;
  priority?: Priority;
  /** The slot of the first try is taken already, with `tryAcquire` */
  reserved?: boolean;
}

/** How one request runs: what stops it, and whether it is tried again. */
export interface TeamsRequestControl {
  /** Aborts the request and every wait of it, such as when the channel stops */
  signal?: AbortSignal;
  /** Tries after the first one, overriding `retry.retries`, `0` for requests better dropped than late */
  retries?: number;
}

/** How long a Bot Connector request may take by default, in ms. */
export const TEAMS_REQUEST_TIMEOUT = 30_000;

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Calls the Bot Connector REST API of a service URL, retrying what Microsoft says to retry. */
export class TeamsClient {
  constructor(private readonly options: TeamsClientOptions) {}

  /**
   * Sends one request, resolving with its parsed JSON body, or `undefined` for an empty one.
   * With `pacing` every try waits for a slot of its conversation, and a throttled try keeps the
   * whole conversation back until Teams says it may go on. A `POST` that timed out is not tried
   * again, since Teams may have taken it.
   */
  async request(
    method: TeamsMethod | 'GET',
    serviceUrl: string,
    path: string,
    body?: unknown,
    pacing?: TeamsPacing,
    control: TeamsRequestControl = {}
  ): Promise<unknown> {
    const retries = control.retries ?? this.options.retry?.retries ?? 3;
    const signal = control.signal;
    const pacer = pacing ? this.options.pacer : undefined;
    let refreshed = false;
    let slotTaken = pacing?.reserved === true;
    for (let attempt = 0; ; attempt++) {
      if (pacer && pacing && !slotTaken) {
        await pacer.acquire(pacing.key, pacing.priority, signal);
      }
      slotTaken = false;
      try {
        return await this.once(method, serviceUrl, path, body, signal);
      } catch (error) {
        if (!(error instanceof FeedError) || signal?.aborted) throw error;
        if (error instanceof TeamsApiError && error.status === 401 && !refreshed) {
          refreshed = true;
          this.options.credentials.invalidate();
          attempt--;
          continue;
        }
        const timedOut = error instanceof TeamsApiError && error.timedOut;
        const retried =
          error.status === undefined
            ? error.code === 'unavailable' && !(timedOut && method === 'POST')
            : RETRIED.has(error.status);
        if (!retried || attempt >= retries) throw error;
        const wait = this.delay(attempt, error.retryAfter);
        if (pacer && pacing) pacer.block(pacing.key, wait);
        else await pause(wait, signal);
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
    body: unknown,
    halt: AbortSignal | undefined
  ): Promise<unknown> {
    const token = await this.options.credentials.token();
    const url = `${trimTrailingSlashes(serviceUrl)}${path}`;
    const timeout = this.options.timeout ?? TEAMS_REQUEST_TIMEOUT;
    let response: Response;
    let text: string;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json; charset=utf-8' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: halt
          ? AbortSignal.any([AbortSignal.timeout(timeout), halt])
          : AbortSignal.timeout(timeout),
      });
      text = await response.text();
    } catch (error) {
      if (halt?.aborted) {
        throw new TeamsApiError(
          'unavailable',
          `${method} ${path} was aborted: the channel stopped`,
          {
            cause: error,
          }
        );
      }
      const timedOut = isTimeout(error);
      throw new TeamsApiError(
        'unavailable',
        timedOut
          ? `${method} ${path} got no answer within ${timeout} ms`
          : `${method} ${path} failed: ${String(error)}`,
        { cause: error, timedOut }
      );
    }
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
