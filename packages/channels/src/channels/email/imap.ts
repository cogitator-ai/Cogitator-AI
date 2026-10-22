/** Where the channel reads mail over IMAP. */
export interface EmailImapConfig {
  host: string;
  /** Default 993 */
  port?: number;
  /** TLS from the start (default true). `false` upgrades with STARTTLS where the server offers it */
  secure?: boolean;
  /** A password (an app password for Gmail and Outlook), or an OAuth2 `accessToken` */
  auth: { user: string; pass?: string; accessToken?: string };
  /** The mailbox to read (default `INBOX`). A mailbox of the bot's own keeps your mail out of it */
  mailbox?: string;
  /**
   * How often to look for new mail besides IMAP IDLE, which reports it at once, in ms
   * (default 60 000). It also catches mail IDLE missed.
   */
  pollInterval?: number;
  /**
   * Only unread mail of the last days is read (default 7), so a first start does not answer a
   * whole inbox. Older unread mail stays as it is.
   */
  lookbackDays?: number;
  /** How many messages are fetched at a time (default 20) */
  batchSize?: number;
  /** How many fetched messages are parsed at once (default 4). They reach the agent in order */
  concurrency?: number;
  /** Further options for the `ImapFlow` client, such as `tls` */
  clientOptions?: Record<string, unknown>;
}

/** What the channel uses of an `ImapFlow` client of `imapflow`, which is loaded on demand. */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  mailboxOpen(path: string): Promise<{ uidValidity: bigint | number | string }>;
  search(
    query: Record<string, unknown>,
    options: { uid: true }
  ): Promise<number[] | false | undefined>;
  fetch(
    range: number[],
    query: { uid: true; source: true },
    options: { uid: true }
  ): AsyncIterable<{ uid: number; source?: Uint8Array }>;
  messageFlagsAdd(range: number[], flags: string[], options: { uid: true }): Promise<boolean>;
  on(event: 'exists' | 'close' | 'error', listener: (arg?: unknown) => void): unknown;
}

interface ImapFlowModule {
  ImapFlow: new (options: Record<string, unknown>) => ImapClient;
}

/** The first wait before reconnecting, in ms. Each failed try doubles it, up to the maximum. */
export const EMAIL_RECONNECT_MIN_DELAY = 1000;
export const EMAIL_RECONNECT_MAX_DELAY = 60_000;

const MAX_TRACKED = 1000;
const DAY = 24 * 60 * 60 * 1000;

async function loadImapFlow(): Promise<ImapFlowModule> {
  try {
    return (await import('imapflow')) as unknown as ImapFlowModule;
  } catch (error) {
    throw new Error('imapflow is required to read mail over IMAP. Install it: pnpm add imapflow', {
      cause: error,
    });
  }
}

/** Runs `task` over `items`, at most `limit` at once, with results in the order of `items`. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Reads a mailbox over IMAP: unread mail, at once through IDLE and on a timer. A message is
 * flagged `\Seen` once it was handed over, so a restart reads only what was not, and the UIDs
 * handed over are remembered in case flagging failed. A dropped connection is opened again, the
 * wait doubling from 1 s up to 60 s while it keeps failing.
 */
export class ImapInbox<T> {
  private client?: ImapClient;
  private stopped = true;
  private syncing?: Promise<void>;
  private again = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private uidValidity?: string;
  private readonly done = new Set<string>();

  constructor(
    private readonly config: EmailImapConfig,
    private readonly parse: (raw: Uint8Array, uid: number) => Promise<T>,
    private readonly deliver: (item: T) => Promise<void>
  ) {}

  /** Connects and reads what is unread. Rejects when the first connection fails. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      await this.connect();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.reconnectTimer);
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
    await this.syncing?.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
  }

  /** Looks for unread mail now, and a call while a look is running makes it look once more after. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    const run = (async () => {
      try {
        do {
          this.again = false;
          await this.syncOnce();
        } while (this.again && !this.stopped);
      } catch (error) {
        console.error('[email] Reading the IMAP mailbox failed:', error);
      } finally {
        this.syncing = undefined;
      }
    })();
    this.syncing = run;
    return run;
  }

  private async connect(): Promise<void> {
    const { ImapFlow } = await loadImapFlow();
    const { host, port, secure, auth, mailbox, clientOptions } = this.config;
    const client = new ImapFlow({
      host,
      port: port ?? 993,
      secure: secure ?? true,
      auth,
      logger: false,
      ...clientOptions,
    });
    client.on('error', (error) => console.error('[email] IMAP connection error:', error));
    client.on('exists', () => void this.sync());
    client.on('close', () => this.closed(client));
    try {
      await client.connect();
      const opened = await client.mailboxOpen(mailbox ?? 'INBOX');
      const validity = String(opened.uidValidity);
      if (this.uidValidity !== undefined && validity !== this.uidValidity) this.done.clear();
      this.uidValidity = validity;
    } catch (error) {
      client.close();
      throw error;
    }
    if (this.stopped) {
      await client.logout().catch(() => client.close());
      return;
    }
    this.client = client;
    this.attempts = 0;
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.sync(), this.config.pollInterval ?? 60_000);
    void this.sync();
  }

  private closed(client: ImapClient): void {
    if (client !== this.client) return;
    this.client = undefined;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (!this.stopped) {
      console.warn('[email] The IMAP connection closed, reconnecting');
      this.reconnect();
    }
  }

  private reconnect(): void {
    const delay = Math.min(
      EMAIL_RECONNECT_MIN_DELAY * 2 ** this.attempts,
      EMAIL_RECONNECT_MAX_DELAY
    );
    this.attempts++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.connect().catch((error: unknown) => {
        console.error(`[email] Reconnecting to IMAP failed (try ${this.attempts}):`, error);
        if (!this.stopped) this.reconnect();
      });
    }, delay);
  }

  private key(uid: number): string {
    return `${this.uidValidity ?? ''}:${uid}`;
  }

  private remember(uid: number): void {
    this.done.add(this.key(uid));
    if (this.done.size > MAX_TRACKED) {
      const oldest = this.done.values().next().value;
      if (oldest !== undefined) this.done.delete(oldest);
    }
  }

  private async syncOnce(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    const since = new Date(Date.now() - (this.config.lookbackDays ?? 7) * DAY);
    const found = await client.search({ seen: false, since }, { uid: true });
    const uids = (found || []).filter((uid) => !this.done.has(this.key(uid))).sort((a, b) => a - b);
    const batchSize = Math.max(1, this.config.batchSize ?? 20);
    for (let start = 0; start < uids.length; start += batchSize) {
      if (this.stopped || client !== this.client) return;
      const batch = uids.slice(start, start + batchSize);
      const sources = new Map<number, Uint8Array>();
      for await (const message of client.fetch(batch, { uid: true, source: true }, { uid: true })) {
        if (message.source) sources.set(message.uid, message.source);
      }
      const fetched = batch.filter((uid) => sources.has(uid));
      const parsed = await mapBounded(fetched, this.config.concurrency ?? 4, (uid) => {
        const source = sources.get(uid);
        if (!source) throw new Error(`Message ${uid} has no source`);
        return this.parse(source, uid);
      });
      for (const [index, uid] of fetched.entries()) {
        if (this.stopped) return;
        const result = parsed[index];
        if (result.status === 'fulfilled') {
          try {
            await this.deliver(result.value);
          } catch (error) {
            console.error(`[email] Handling message ${uid} failed:`, error);
          }
        } else {
          console.error(`[email] Could not read message ${uid}, it is marked read:`, result.reason);
        }
        this.remember(uid);
        await client
          .messageFlagsAdd([uid], ['\\Seen'], { uid: true })
          .catch((error: unknown) =>
            console.error(`[email] Could not mark message ${uid} read:`, error)
          );
      }
    }
  }
}
