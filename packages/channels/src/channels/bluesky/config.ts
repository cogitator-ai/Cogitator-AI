import type { TokenStore } from '@cogitator-ai/types';

export interface BlueskyConnectionConfig {
  /** The account's handle (`newsroom.bsky.social`) or DID. */
  identifier: string;
  /** An app password from Settings → Privacy and security → App passwords, not the account password. */
  appPassword: string;
  /** The PDS to sign in to (default `https://bsky.social`). */
  service?: string;
  /** Where the session is kept so a restart does not sign in again (default in memory). */
  store?: TokenStore;
  /** The session's key in the store (default `bluesky:<identifier>`). */
  storeKey?: string;
  /** The fetch the client uses, for tests and proxies. */
  fetch?: typeof fetch;
}
