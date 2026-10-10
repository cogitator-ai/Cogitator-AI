import type { Agent, AtpSessionData, AtpSessionEvent, CredentialSession } from '@atproto/api';
import type { TokenStore } from '@cogitator-ai/types';
import type { BlueskyConnectionConfig } from './config';
import { FeedError, type FeedErrorCode, feedErrorCode } from '../../feeds/errors';
import { MemoryTokenStore } from '../../feeds/token-store';

type AtprotoModule = typeof import('@atproto/api');

let atproto: Promise<AtprotoModule> | undefined;

/** `@atproto/api`, loaded on first use since it is an optional peer dependency. */
export function loadAtproto(): Promise<AtprotoModule> {
  atproto ??= import('@atproto/api').catch((error: unknown) => {
    atproto = undefined;
    throw new Error(
      '@atproto/api is required for Bluesky support. Install it: pnpm add @atproto/api',
      { cause: error }
    );
  });
  return atproto;
}

const XRPC_CODES: Record<string, FeedErrorCode> = {
  AuthenticationRequired: 'auth',
  AuthFactorTokenRequired: 'auth',
  AccountTakedown: 'auth',
  InvalidToken: 'auth',
  ExpiredToken: 'token_expired',
  RateLimitExceeded: 'rate_limited',
  InvalidRequest: 'invalid_post',
  BlobTooLarge: 'invalid_post',
  NotFound: 'not_found',
  RecordNotFound: 'not_found',
  XRPCNotSupported: 'auth',
};

/** A failure of the Bluesky API as a `FeedError`, keeping the wait a rate limit asks for. */
export function blueskyError(error: unknown, action: string): FeedError {
  if (error instanceof FeedError) return error;
  if (typeof error === 'object' && error !== null && 'status' in error && 'error' in error) {
    const status = Number(error.status);
    const name = typeof error.error === 'string' ? error.error : '';
    const headers =
      'headers' in error && typeof error.headers === 'object' && error.headers !== null
        ? (error.headers as Record<string, string>)
        : {};
    const reset = Number(headers['ratelimit-reset']);
    const message = error instanceof Error ? error.message : name;
    const code =
      XRPC_CODES[name] ?? (status > 1 ? feedErrorCode(status) : ('unavailable' as const));
    const hint =
      name === 'XRPCNotSupported'
        ? ': direct messages need an app password created with "Allow access to your direct messages"'
        : '';
    return new FeedError('bluesky', code, `${action} failed: ${message}${hint}`, {
      ...(status > 1 ? { status } : {}),
      ...(Number.isFinite(reset) && reset > 0
        ? { retryAfter: Math.max(0, reset * 1000 - Date.now()) }
        : {}),
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FeedError('bluesky', 'unavailable', `${action} failed: ${message}`, { cause: error });
}

/**
 * A signed-in Bluesky account, shared by the feed and the chat channel of
 * one account. The session is resumed from the store when it holds one and
 * kept there as it is refreshed. A session that cannot be resumed, or that
 * expires because its refresh token was used up (by another process sharing
 * the store, say), is replaced by a new sign-in with the app password.
 */
export class BlueskyConnection {
  readonly config: BlueskyConnectionConfig;
  private readonly store: TokenStore;
  private readonly key: string;
  private connecting?: Promise<Agent>;
  private session?: CredentialSession;

  constructor(config: BlueskyConnectionConfig) {
    if (!config.identifier) throw new Error('Bluesky needs the account handle or DID');
    if (!config.appPassword) throw new Error('Bluesky needs an app password');
    this.config = config;
    this.store = config.store ?? new MemoryTokenStore();
    this.key = config.storeKey ?? `bluesky:${config.identifier}`;
  }

  /** The signed-in agent, signing in on first use. */
  agent(): Promise<Agent> {
    this.connecting ??= this.connect().catch((error: unknown) => {
      this.connecting = undefined;
      throw blueskyError(error, 'Signing in to Bluesky');
    });
    return this.connecting;
  }

  /**
   * Runs `action` with the signed-in agent, and once more after signing in
   * again when the session expired while it ran.
   */
  async use<T>(action: (agent: Agent) => Promise<T>): Promise<T> {
    const agent = await this.agent();
    const session = this.session;
    try {
      return await action(agent);
    } catch (error) {
      if (this.session === session && this.connecting) throw error;
      return action(await this.agent());
    }
  }

  /** The DID of the signed-in account. */
  async did(): Promise<string> {
    const agent = await this.agent();
    if (!agent.did) throw new FeedError('bluesky', 'auth', 'The Bluesky session has no DID');
    return agent.did;
  }

  private async connect(): Promise<Agent> {
    const { Agent: AgentClass, CredentialSession: SessionClass } = await loadAtproto();
    const session: CredentialSession = new SessionClass(
      new URL(this.config.service ?? 'https://bsky.social'),
      this.config.fetch,
      (event, data) => this.persist(session, event, data)
    );
    const agent = new AgentClass(session);
    const stored = await this.store.get(this.key);
    let resumed = false;
    if (stored) {
      try {
        await session.resumeSession(JSON.parse(stored.value) as AtpSessionData);
        resumed = true;
      } catch {
        await this.store.delete(this.key);
      }
    }
    if (!resumed) {
      await session.login({
        identifier: this.config.identifier,
        password: this.config.appPassword,
      });
    }
    this.session = session;
    return agent;
  }

  private async persist(
    session: CredentialSession,
    event: AtpSessionEvent,
    data: AtpSessionData | undefined
  ): Promise<void> {
    if (event === 'expired' && this.session === session) {
      this.session = undefined;
      this.connecting = undefined;
    }
    try {
      if ((event === 'create' || event === 'update') && data) {
        await this.store.set(this.key, { value: JSON.stringify(data), issuedAt: Date.now() });
      } else if (event === 'expired' || event === 'create-failed') {
        await this.store.delete(this.key);
      }
    } catch (error) {
      console.error('[bluesky] Could not save the session:', error);
    }
  }
}

const connections = new WeakMap<object, BlueskyConnection>();

/** Ties an account object to its connection. */
export function register(account: object, connection: BlueskyConnection): void {
  connections.set(account, connection);
}

/** The connection behind an account, for the feed and channel of this package. */
export function connectionOf(account: object): BlueskyConnection {
  const connection = connections.get(account);
  if (!connection) throw new Error('Not a BlueskyAccount');
  return connection;
}
