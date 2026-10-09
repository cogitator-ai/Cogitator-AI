import type { StoredToken, TokenStore } from '@cogitator-ai/types';
import { FeedError } from '../../feeds/errors';
import { MemoryTokenStore } from '../../feeds/token-store';
import type { ThreadsClient } from './client';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export interface ThreadsTokenOptions {
  /** A long-lived token to start from when the store holds none. */
  accessToken?: string;
  /** When `accessToken` expires, where known. Otherwise the first renewal finds out. */
  accessTokenExpiresAt?: Date | number;
  /** Where the token is kept and renewed (default in memory). */
  store?: TokenStore;
  /** The token's key in the store (default `threads`). */
  storeKey?: string;
  /** How long before it expires the token is renewed (default seven days). */
  renewBefore?: number;
  /** Called with the new token after each renewal. */
  onTokenRenewed?: (token: StoredToken) => void | Promise<void>;
  now?: () => number;
}

/**
 * A Threads long-lived token kept fresh. Threads renews a token that is at
 * least a day old and not yet expired, for sixty days. One left alone
 * expires and cannot be renewed. The manager renews it `renewBefore` its
 * end, checks daily once started, and before each use. A token whose expiry
 * is unknown is renewed at the first chance, which reveals it. Calls made at
 * the same time share one renewal. Before renewing, the manager rereads the
 * store, so a token another process renewed is used as it is. Two processes
 * renewing at the same moment both get valid tokens.
 */
export class ThreadsTokenManager {
  private readonly store: TokenStore;
  private readonly key: string;
  private readonly renewBefore: number;
  private readonly now: () => number;
  private nextAttemptAt = 0;
  private renewing?: Promise<StoredToken>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly client: ThreadsClient,
    private readonly options: ThreadsTokenOptions
  ) {
    this.store = options.store ?? new MemoryTokenStore();
    this.key = options.storeKey ?? 'threads';
    this.renewBefore = options.renewBefore ?? 7 * DAY;
    this.now = options.now ?? Date.now;
  }

  /** A token to call the API with, renewed first when it is due. */
  async token(): Promise<string> {
    const current = await this.current();
    if (current.expiresAt !== undefined && current.expiresAt <= this.now()) {
      throw new FeedError(
        'threads',
        'token_expired',
        `The Threads token expired on ${new Date(current.expiresAt).toISOString()}: sign in again for a new long-lived token`
      );
    }
    if (this.due(current)) {
      try {
        return (await this.renewOnce(false)).value;
      } catch (error) {
        if (error instanceof FeedError && error.code === 'token_expired') throw error;
        console.warn('[threads] Could not renew the token, using the current one:', error);
      }
    }
    return current.value;
  }

  /** Renews the token now, whatever its age. */
  renew(): Promise<StoredToken> {
    return this.renewOnce(true);
  }

  private renewOnce(force: boolean): Promise<StoredToken> {
    this.renewing ??= this.doRenew(force).finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  /** Checks the token every day until `stop()`. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.token().catch((error: unknown) =>
        console.error('[threads] The daily token check failed:', error)
      );
    }, DAY);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async current(): Promise<StoredToken> {
    const stored = await this.store.get(this.key);
    if (stored) return stored;
    if (!this.options.accessToken) {
      throw new FeedError(
        'threads',
        'auth',
        'No Threads token: pass accessToken or put one in the token store'
      );
    }
    const expiresAt = this.options.accessTokenExpiresAt;
    const seeded: StoredToken = {
      value: this.options.accessToken,
      issuedAt: this.now(),
      ...(expiresAt !== undefined && {
        expiresAt: typeof expiresAt === 'number' ? expiresAt : expiresAt.getTime(),
      }),
    };
    await this.store.set(this.key, seeded);
    return seeded;
  }

  private due(token: StoredToken): boolean {
    if (this.now() < this.nextAttemptAt) return false;
    if (token.expiresAt === undefined) return true;
    return token.expiresAt - this.now() <= this.renewBefore && this.now() - token.issuedAt >= DAY;
  }

  private async doRenew(force: boolean): Promise<StoredToken> {
    const latest = await this.current();
    if (!force && !this.due(latest)) return latest;
    try {
      const response = await this.client.get<{ access_token: string; expires_in?: number }>(
        'refresh_access_token',
        latest.value,
        { grant_type: 'th_refresh_token' }
      );
      const now = this.now();
      const renewed: StoredToken = {
        value: response.access_token,
        issuedAt: now,
        ...(response.expires_in !== undefined && { expiresAt: now + response.expires_in * 1000 }),
      };
      await this.store.set(this.key, renewed);
      this.nextAttemptAt = 0;
      try {
        await this.options.onTokenRenewed?.(renewed);
      } catch (error) {
        console.error('[threads] onTokenRenewed failed:', error);
      }
      return renewed;
    } catch (error) {
      this.nextAttemptAt = this.now() + HOUR;
      throw error;
    }
  }
}
