import { nextPageQuery, ThreadsClient, type ThreadsPage, type ThreadsParams } from './client';
import { ThreadsTokenManager, type ThreadsTokenOptions } from './token';

export interface ThreadsAccountConfig extends ThreadsTokenOptions {
  /** The Threads user id the token belongs to (default `me`). */
  userId?: string;
  /** The Graph API base (default `https://graph.threads.net/v1.0`). */
  apiBase?: string;
  /** The fetch the client uses, for tests and proxies. */
  fetch?: typeof fetch;
}

/**
 * One Threads account: its API client and its long-lived token, kept fresh.
 * Share it between `ThreadsFeed` and `ThreadsChannel` so they renew one
 * token.
 */
export class ThreadsAccount {
  readonly userId: string;
  private readonly client: ThreadsClient;
  private readonly tokens: ThreadsTokenManager;

  constructor(config: ThreadsAccountConfig) {
    this.userId = config.userId ?? 'me';
    this.client = new ThreadsClient({
      ...(config.apiBase && { base: config.apiBase }),
      ...(config.fetch && { fetch: config.fetch }),
    });
    this.tokens = new ThreadsTokenManager(this.client, config);
  }

  /** Loads the token, renewing it if due, and checks it daily from now on. */
  async connect(): Promise<void> {
    await this.tokens.token();
    this.tokens.start();
  }

  /** Stops the daily token check. */
  close(): void {
    this.tokens.stop();
  }

  /** Renews the token now, whatever its age. */
  async renewToken(): Promise<void> {
    await this.tokens.renew();
  }

  async get<T>(path: string, params?: ThreadsParams, signal?: AbortSignal): Promise<T> {
    return this.client.get<T>(path, await this.tokens.token(), params, signal);
  }

  /** The items of a listing, page by page, following its cursors for `maxPages` at most. */
  async *pages<T>(
    path: string,
    params: ThreadsParams,
    maxPages: number,
    signal?: AbortSignal
  ): AsyncGenerator<T[]> {
    let query: ThreadsParams | undefined = params;
    for (let page = 0; page < maxPages && query; page++) {
      const response: ThreadsPage<T> = await this.get<ThreadsPage<T>>(path, query, signal);
      yield response.data ?? [];
      query = nextPageQuery(response, query);
    }
  }

  async post<T>(path: string, params?: ThreadsParams, signal?: AbortSignal): Promise<T> {
    return this.client.post<T>(path, await this.tokens.token(), params, signal);
  }

  async delete<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.client.delete<T>(path, await this.tokens.token(), signal);
  }
}

/** The account a feed or channel config names, or a new one for its token. */
export function threadsAccountOf(
  config: { account: ThreadsAccount } | ThreadsAccountConfig
): ThreadsAccount {
  return 'account' in config ? config.account : new ThreadsAccount(config);
}
