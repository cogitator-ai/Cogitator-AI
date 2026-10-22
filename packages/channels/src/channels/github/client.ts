import { FeedError, type FeedErrorCode, feedErrorCode, retryAfterOf } from '../../feeds/errors';

export const GITHUB_API = 'https://api.github.com';

/** How long GitHub asks to wait after a secondary rate limit that names no time, in ms. */
const SECONDARY_LIMIT_WAIT = 60_000;

/**
 * The token the channel calls GitHub with: a personal access token, or a
 * function that returns one, such as a GitHub App installation token it
 * renews before it expires. The function is called before every request.
 */
export type GitHubToken = string | (() => string | Promise<string>);

export type GitHubMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** The error body of a REST API response. */
export interface GitHubErrorBody {
  message?: string;
  errors?: Array<string | { message?: string; code?: string; field?: string }>;
  documentation_url?: string;
}

function isRateLimit(status: number, headers: Headers, body: GitHubErrorBody): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body.message ?? '');
}

/** The feed error code a REST API error means. */
export function githubErrorCode(
  status: number,
  headers: Headers,
  body: GitHubErrorBody
): FeedErrorCode {
  if (isRateLimit(status, headers, body)) return 'rate_limited';
  if (status === 410) return 'not_found';
  return feedErrorCode(status);
}

/**
 * How long a failed request asks to wait, in ms: `Retry-After` where GitHub
 * sends it, the reset of the primary rate limit when it is used up, and a
 * minute for a secondary rate limit that names no time, as GitHub advises.
 */
export function githubRetryAfter(
  status: number,
  headers: Headers,
  body: GitHubErrorBody,
  now = Date.now()
): number | undefined {
  const after = retryAfterOf(headers, now);
  if (after !== undefined) return after;
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  }
  return isRateLimit(status, headers, body) ? SECONDARY_LIMIT_WAIT : undefined;
}

function errorBodyOf(value: unknown, text: string): GitHubErrorBody {
  if (typeof value !== 'object' || value === null) return { message: text.slice(0, 300) };
  const record = value as Record<string, unknown>;
  const errors = Array.isArray(record.errors)
    ? record.errors.filter(
        (item): item is string | { message?: string } =>
          typeof item === 'string' || (typeof item === 'object' && item !== null)
      )
    : undefined;
  return {
    ...(typeof record.message === 'string' && { message: record.message }),
    ...(errors && { errors }),
    ...(typeof record.documentation_url === 'string' && {
      documentation_url: record.documentation_url,
    }),
  };
}

function describe(body: GitHubErrorBody, status: number): string {
  const details = (body.errors ?? [])
    .map((item) => (typeof item === 'string' ? item : item.message))
    .filter((item): item is string => !!item);
  const message = body.message ?? `HTTP ${status}`;
  return details.length > 0 ? `${message} (${details.join(', ')})` : message;
}

export interface GitHubClientOptions {
  token: GitHubToken;
  /** The REST API root, `https://<host>/api/v3` on GitHub Enterprise Server (default `https://api.github.com`). */
  apiUrl?: string;
  fetch?: typeof fetch;
}

/** `value` without the slashes it ends with, in linear time, unlike `replace(/\/+$/, '')`. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** Calls the GitHub REST API with a token, turning its errors into `FeedError`s. */
export class GitHubClient {
  private readonly base: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.base = trimTrailingSlashes(options.apiUrl ?? GITHUB_API);
  }

  /**
   * Sends one request and resolves with the parsed JSON body, or `undefined`
   * for an empty one (such as `204 No Content`).
   */
  async request(method: GitHubMethod, path: string, body?: unknown): Promise<unknown> {
    const token =
      typeof this.options.token === 'function' ? await this.options.token() : this.options.token;
    const init: RequestInit = {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'cogitator-channels',
        'x-github-api-version': '2022-11-28',
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.base}${path}`, init);
    } catch (error) {
      throw new FeedError('github', 'unavailable', `${method} ${path} failed: ${String(error)}`, {
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
    if (!response.ok) {
      const error = errorBodyOf(parsed, text);
      const retryAfter = githubRetryAfter(response.status, response.headers, error);
      throw new FeedError(
        'github',
        githubErrorCode(response.status, response.headers, error),
        `${method} ${path} failed: ${describe(error, response.status)}`,
        {
          status: response.status,
          ...(retryAfter !== undefined && { retryAfter }),
          cause: parsed ?? text,
        }
      );
    }
    return parsed;
  }
}
