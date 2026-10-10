import type { BlueskyConnectionConfig } from './config';
import { BlueskyConnection, connectionOf, register } from './connection';

/**
 * One Bluesky account and its session, to share between `BlueskyFeed` and
 * `BlueskyChannel` so they sign in once and refresh one session.
 */
export class BlueskyAccount {
  readonly identifier: string;

  constructor(config: BlueskyConnectionConfig) {
    this.identifier = config.identifier;
    register(this, new BlueskyConnection(config));
  }

  /** Signs in, or resumes the stored session. */
  async connect(): Promise<void> {
    await connectionOf(this).agent();
  }

  /** The DID of the account, signing in if needed. */
  did(): Promise<string> {
    return connectionOf(this).did();
  }
}

/** The account a feed or channel config names, or a new one for its credentials. */
export function accountOf(
  config: { account: BlueskyAccount } | BlueskyConnectionConfig
): BlueskyAccount {
  return 'account' in config ? config.account : new BlueskyAccount(config);
}
