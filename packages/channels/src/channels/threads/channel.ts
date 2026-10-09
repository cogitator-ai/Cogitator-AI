import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Attachment, Channel, ChannelMessage, SendOptions } from '@cogitator-ai/types';
import { splitText, threadsLength } from '../../feeds/text';
import { threadsAccountOf, type ThreadsAccount, type ThreadsAccountConfig } from './account';
import { ThreadsFeed } from './feed';

const MAX_TRACKED = 1000;
const POST_LIMIT = 500;
const POST_FIELDS = 'id,text,username,timestamp,permalink,replied_to,root_post,is_reply';

export interface ThreadsWebhookConfig {
  /** The app secret that signs Meta's deliveries. */
  appSecret: string;
  /** The verify token set for the callback URL in the app dashboard. */
  verifyToken: string;
}

export type ThreadsChannelConfig = ({ account: ThreadsAccount } | ThreadsAccountConfig) & {
  /**
   * Takes replies and mentions from Meta's webhooks, on its own HTTP server
   * when `port` is set, or through `handleWebhook` mounted in your server.
   * Without it the channel polls.
   */
  webhook?: ThreadsWebhookConfig & { port?: number; path?: string; host?: string };
  /** How often to poll mentions and replies when there is no webhook, in ms (default 60 000). */
  pollInterval?: number;
  /** How many of the account's latest posts polling watches for replies (default 10). */
  watchPosts?: number;
};

/** A webhook delivery, as any HTTP server hands it over. */
export interface ThreadsWebhookRequest {
  method: string;
  /** The query string parameters. */
  query: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** The body exactly as received, which the signature covers. */
  rawBody?: string | Uint8Array;
}

export interface ThreadsWebhookResponse {
  status: number;
  body: string;
}

interface ThreadsPost {
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  permalink?: string;
  replied_to?: { id: string };
  root_post?: { id: string; username?: string };
  is_reply?: boolean;
}

function header(headers: ThreadsWebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Whether `signature` (`sha256=<hex>`) is the HMAC of `body` with `secret`. */
export function verifyThreadsSignature(
  body: string | Uint8Array,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(signature.slice('sha256='.length));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The posts a webhook payload carries, in Threads' shape or Meta's `entry` wrapping. */
function postsOf(payload: unknown): ThreadsPost[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const values: unknown[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) {
      const inner = (value as Record<string, unknown>).value;
      values.push(inner ?? value);
    }
  };
  if (record.values) collect(record.values);
  if (Array.isArray(record.entry)) {
    for (const entry of record.entry) {
      if (typeof entry === 'object' && entry !== null) {
        const { changes, values: entryValues } = entry as Record<string, unknown>;
        if (changes) collect(changes);
        if (entryValues) collect(entryValues);
      }
    }
  }
  return values.filter(
    (value): value is ThreadsPost =>
      typeof value === 'object' && value !== null && typeof (value as ThreadsPost).id === 'string'
  );
}

/**
 * A conversational Threads channel: an agent answers replies to the
 * account's posts and mentions of it, under the post it answers. Replies and
 * mentions come from Meta's webhooks (signed with the app secret) or, without
 * them, from polling. Threads has no direct messages in its API and cannot
 * edit posts, so answers are sent once finished, as several replies when
 * long. A message's `channelId` is `post:<media id>` to answer under that
 * post, or `feed` for a new post.
 */
export class ThreadsChannel implements Channel {
  readonly type = 'threads';
  readonly editable = false;
  readonly nativeMarkdown = false;
  readonly maxMessageChars = Infinity;
  readonly account: ThreadsAccount;
  private readonly feed: ThreadsFeed;
  private readonly config: ThreadsChannelConfig;
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private readonly seen = new Map<string, true>();
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private identity?: Promise<void>;
  private username?: string;
  private since = 0;
  private running = false;

  constructor(config: ThreadsChannelConfig) {
    this.config = config;
    this.account = threadsAccountOf(config);
    this.feed = new ThreadsFeed({ account: this.account });
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.account.connect();
    await this.identify();
    this.since = Date.now();
    this.running = true;
    const webhook = this.config.webhook;
    if (webhook?.port !== undefined) {
      await this.listen(webhook.port, webhook.path ?? '/threads/webhook', webhook.host);
    } else if (!webhook) {
      this.timer = setInterval(() => void this.poll(), this.config.pollInterval ?? 60_000);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.polling;
    this.account.close();
  }

  /**
   * Answers a webhook request: the verification Meta sends when the callback
   * URL is set, and signed deliveries of replies and mentions. Mount it in
   * any HTTP server, with the raw body unparsed. It works before `start()`
   * too: the first delivery loads the account's username, so the bot's own
   * replies are skipped.
   */
  async handleWebhook(request: ThreadsWebhookRequest): Promise<ThreadsWebhookResponse> {
    const webhook = this.config.webhook;
    if (!webhook) return { status: 404, body: 'Webhooks are not configured' };
    if (request.method === 'GET') {
      const {
        'hub.mode': mode,
        'hub.verify_token': token,
        'hub.challenge': challenge,
      } = request.query;
      if (mode === 'subscribe' && token === webhook.verifyToken && challenge) {
        return { status: 200, body: challenge };
      }
      return { status: 403, body: 'Verification failed' };
    }
    if (request.method !== 'POST') return { status: 405, body: 'Method not allowed' };
    const raw = request.rawBody ?? '';
    if (
      !verifyThreadsSignature(
        raw,
        header(request.headers, 'x-hub-signature-256'),
        webhook.appSecret
      )
    ) {
      return { status: 401, body: 'Invalid signature' };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8'));
    } catch {
      return { status: 400, body: 'Invalid JSON' };
    }
    try {
      await this.identify();
    } catch (error) {
      console.error('[threads] Could not load the account for a webhook delivery:', error);
      return { status: 503, body: 'The account could not be loaded' };
    }
    void this.receive(postsOf(payload)).catch((error: unknown) =>
      console.error('[threads] Webhook delivery failed:', error)
    );
    return { status: 200, body: 'OK' };
  }

  /**
   * Looks for new replies and mentions once. A started channel without
   * webhooks polls on a timer. Of the conversations under the bot's latest
   * posts it takes the replies to the bot's posts and the posts that mention
   * it, not what people answer each other.
   */
  poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        await this.identify();
        const user = this.account.userId;
        const mentions = await this.account.get<{ data?: ThreadsPost[] }>(`${user}/mentions`, {
          fields: POST_FIELDS,
          limit: 25,
        });
        const own = await this.account.get<{ data?: ThreadsPost[] }>(`${user}/threads`, {
          fields: 'id,timestamp',
          limit: this.config.watchPosts ?? 10,
        });
        const conversations: ThreadsPost[] = [];
        for (const post of own.data ?? []) {
          const conversation = await this.account.get<{ data?: ThreadsPost[] }>(
            `${post.id}/conversation`,
            { fields: POST_FIELDS, limit: 50 }
          );
          conversations.push(...(conversation.data ?? []));
        }
        const botPosts = new Set((own.data ?? []).map((post) => post.id));
        for (const post of conversations) if (this.isOwn(post)) botPosts.add(post.id);
        const replies = conversations.filter(
          (post) =>
            (post.replied_to !== undefined && botPosts.has(post.replied_to.id)) ||
            this.mentionsBot(post.text)
        );
        await this.receive(
          [...(mentions.data ?? []), ...replies].filter(
            (post) => post.timestamp === undefined || Date.parse(post.timestamp) >= this.since
          )
        );
      } catch (error) {
        console.error('[threads] Polling failed:', error);
      }
    })().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const target = parseTarget(channelId);
    const parts = splitText(text, POST_LIMIT, threadsLength);
    if (parts.length === 0) throw new Error('[threads] Nothing to send');
    let replyTo = options?.replyTo ?? target;
    let first: string | undefined;
    for (const part of parts) {
      const published = await this.feed.publish({ text: part, ...(replyTo && { replyTo }) });
      first ??= published.id;
      replyTo = published.id;
    }
    return first ?? '';
  }

  editText(): Promise<void> {
    return Promise.reject(new Error('[threads] Threads posts cannot be edited'));
  }

  async sendFile(channelId: string, file: Attachment, options?: SendOptions): Promise<string> {
    const replyTo = options?.replyTo ?? parseTarget(channelId);
    const published = await this.feed.publish({
      text: file.caption ?? '',
      images: [{ image: file }],
      ...(replyTo && { replyTo }),
    });
    return published.id;
  }

  async sendTyping(): Promise<void> {}

  async deleteMessage(_channelId: string, messageId: string): Promise<void> {
    await this.feed.delete(messageId);
  }

  private async receive(posts: ThreadsPost[]): Promise<void> {
    const fresh = posts
      .filter((post) => !this.isOwn(post))
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    for (const post of fresh) {
      if (!this.remember(post.id) || !post.text?.trim() || !this.handler) continue;
      const root = post.root_post?.id ?? post.id;
      const message: ChannelMessage = {
        id: post.id,
        channelType: this.type,
        channelId: `post:${post.id}`,
        userId: post.username ?? '',
        ...(post.username && { userName: post.username }),
        groupId: `thread:${root}`,
        text: this.stripMention(post.text),
        ...(post.replied_to && { replyTo: post.replied_to.id }),
        raw: post,
      };
      try {
        await this.handler(message);
      } catch (error) {
        console.error('[threads] Message handler error:', error);
      }
    }
  }

  /** Loads the account's username once, for telling its own posts and its mentions apart. */
  private identify(): Promise<void> {
    this.identity ??= this.account
      .get<{ id: string; username?: string }>(this.account.userId, { fields: 'id,username' })
      .then((me) => {
        this.username = me.username;
      })
      .catch((error: unknown) => {
        this.identity = undefined;
        throw error;
      });
    return this.identity;
  }

  private isOwn(post: ThreadsPost): boolean {
    return (
      this.username !== undefined && post.username?.toLowerCase() === this.username.toLowerCase()
    );
  }

  private mentionsBot(text: string | undefined): boolean {
    if (!this.username || !text) return false;
    const escaped = this.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w.@])@${escaped}(?![\\w]|\\.[\\w])`, 'iu').test(text);
  }

  private stripMention(text: string): string {
    if (!this.username) return text.trim();
    const escaped = this.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`^\\s*@${escaped}\\b[\\s,:]*`, 'i'), '').trim() || text.trim();
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, true);
    if (this.seen.size > MAX_TRACKED) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  private listen(port: number, path: string, host?: string): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      readBody(req)
        .then((rawBody) =>
          this.handleWebhook({
            method: req.method ?? 'GET',
            query: Object.fromEntries(url.searchParams),
            headers: req.headers,
            rawBody,
          })
        )
        .then((response) =>
          res.writeHead(response.status, { 'content-type': 'text/plain' }).end(response.body)
        )
        .catch((error: unknown) => {
          console.error('[threads] Webhook request failed:', error);
          res.writeHead(500).end();
        });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  }
}

const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Webhook body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The post a `channelId` answers under, or none for a new post. */
function parseTarget(channelId: string): string | undefined {
  if (channelId === 'feed') return undefined;
  if (channelId.startsWith('post:')) return channelId.slice(5);
  throw new Error(`[threads] Unknown channel id "${channelId}": use post:<media id> or feed`);
}

/** A conversational Threads channel. */
export function threadsChannel(config: ThreadsChannelConfig): ThreadsChannel {
  return new ThreadsChannel(config);
}
