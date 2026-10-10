import { FeedError, type FeedErrorCode, feedErrorCode, retryAfterOf } from '../../feeds/errors';

export const THREADS_API = 'https://graph.threads.net/v1.0';

/** The error object of a Graph API response. */
interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  fbtrace_id?: string;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** The feed error code a Graph API error means. */
export function threadsErrorCode(status: number, error: GraphError): FeedErrorCode {
  const text = `${error.message ?? ''} ${error.error_user_msg ?? ''}`;
  if (error.code === 190) return error.error_subcode === 463 ? 'token_expired' : 'auth';
  if (error.code !== undefined && RATE_LIMIT_CODES.has(error.code)) return 'rate_limited';
  if (/LINK_LIMIT_EXCEEDED|limit how often|publishing limit/i.test(text)) {
    return text.includes('LINK_LIMIT_EXCEEDED') ? 'invalid_post' : 'quota_exceeded';
  }
  if (error.code === 10 || error.code === 200) return 'auth';
  return feedErrorCode(status);
}

export type ThreadsParams = Record<string, string | number | boolean | undefined>;

/** One page of a Graph API listing. */
export interface ThreadsPage<T> {
  data?: T[];
  paging?: { cursors?: { before?: string; after?: string }; next?: string; previous?: string };
}

/** The query of the page after `page`, or none when it was the last. */
export function nextPageQuery<T>(
  page: ThreadsPage<T>,
  query: ThreadsParams
): ThreadsParams | undefined {
  const count = page.data?.length ?? 0;
  if (count === 0) return undefined;
  const { cursors, next } = page.paging ?? {};
  if (!next && typeof query.limit === 'number' && count < query.limit) return undefined;
  if (cursors?.after && cursors.after !== query.after) return { ...query, after: cursors.after };
  if (!next) return undefined;
  try {
    const params = [...new URL(next).searchParams].filter(([name]) => name !== 'access_token');
    return params.length > 0 ? { ...query, ...Object.fromEntries(params) } : undefined;
  } catch {
    return undefined;
  }
}

/** Calls the Threads Graph API with a token, turning its errors into `FeedError`s. */
export class ThreadsClient {
  constructor(private readonly options: { base?: string; fetch?: typeof fetch } = {}) {}

  async get<T>(
    path: string,
    token: string,
    params: ThreadsParams = {},
    signal?: AbortSignal
  ): Promise<T> {
    const url = new URL(`${this.options.base ?? THREADS_API}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries({ ...params, access_token: token })) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.send<T>(url, { method: 'GET', ...(signal && { signal }) }, path);
  }

  async post<T>(
    path: string,
    token: string,
    params: ThreadsParams = {},
    signal?: AbortSignal
  ): Promise<T> {
    const url = new URL(`${this.options.base ?? THREADS_API}/${path.replace(/^\//, '')}`);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, access_token: token })) {
      if (value !== undefined) body.set(key, String(value));
    }
    return this.send<T>(url, { method: 'POST', body, ...(signal && { signal }) }, path);
  }

  async delete<T>(path: string, token: string, signal?: AbortSignal): Promise<T> {
    const url = new URL(`${this.options.base ?? THREADS_API}/${path.replace(/^\//, '')}`);
    url.searchParams.set('access_token', token);
    return this.send<T>(url, { method: 'DELETE', ...(signal && { signal }) }, path);
  }

  private async send<T>(url: URL, init: RequestInit, path: string): Promise<T> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new FeedError(
        'threads',
        'unavailable',
        `${init.method} ${path} failed: ${String(error)}`,
        {
          cause: error,
        }
      );
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: { message: text.slice(0, 300) } };
    }
    const error =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object'
        ? (body.error as GraphError)
        : undefined;
    if (!response.ok || error) {
      const graph = error ?? { message: `HTTP ${response.status}` };
      const retryAfter = retryAfterOf(response.headers);
      throw new FeedError(
        'threads',
        threadsErrorCode(response.status, graph),
        `${init.method} ${path} failed: ${graph.error_user_msg ?? graph.message ?? `HTTP ${response.status}`}`,
        { status: response.status, ...(retryAfter !== undefined && { retryAfter }), cause: body }
      );
    }
    return body as T;
  }
}
