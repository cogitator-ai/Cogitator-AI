import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { z } from 'zod';
import type { Attachment, Channel, ChannelMessage, SendOptions } from '@cogitator-ai/types';
import { FeedError } from '../../feeds/errors';
import { chunkMessage } from '../../formatters/markdown';
import { GitHubClient, type GitHubToken } from './client';
import { githubInboundOf, isGitHubEventName, type GitHubSender } from './events';

/** The longest comment GitHub takes, in characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;

const MAX_TRACKED = 1000;
const MAX_BODY = 1024 * 1024;

/**
 * The reactions GitHub has, by the emoji each shows, and the nearest one for
 * the emojis of status reactions: thinking is eyes, a tool a rocket, an error
 * confused.
 */
const REACTIONS: Record<string, string> = {
  '\u{1F44D}': '+1',
  '\u{1F44E}': '-1',
  '\u{1F604}': 'laugh',
  '\u{1F606}': 'laugh',
  '\u{1F615}': 'confused',
  '❤️': 'heart',
  '❤': 'heart',
  '\u{1F389}': 'hooray',
  '\u{1F680}': 'rocket',
  '\u{1F440}': 'eyes',
  '\u{1F914}': 'eyes',
  '\u{1F525}': 'rocket',
  '\u{1F631}': 'confused',
};
const REACTION_NAMES = new Set(Object.values(REACTIONS));

const CommentSchema = z.object({ id: z.number() });
const ReactionSchema = z.object({ id: z.number() });
const UserSchema = z.object({ login: z.string() });

export interface GitHubWebhookConfig {
  /** The secret set on the webhook, which signs every delivery. Required. */
  secret: string;
  /** Run an HTTP server of the channel's own on this port. Without it, mount `handleWebhook`. */
  port?: number;
  /** The path of the channel's own server (default `/github/webhook`). */
  path?: string;
  host?: string;
}

export interface GitHubChannelConfig {
  /**
   * A personal access token, a GitHub App installation token, or a function
   * that returns a fresh one before every request. It needs to read and write
   * issues and pull requests of the repositories the bot answers in.
   */
  token: GitHubToken;
  /** Where deliveries come from: GitHub only pushes events, so the webhook is required. */
  webhook: GitHubWebhookConfig;
  /**
   * The bot's login, for skipping its own comments and finding mentions of it.
   * Loaded with `GET /user` when not set, which a GitHub App installation
   * token cannot do: an app sets it to `<app-slug>[bot]`.
   */
  login?: string;
  /**
   * Which events the bot answers: `mention` (default) answers only those
   * that mention `@login`, `all` every new issue, pull request, comment and
   * review in the allowed repositories.
   */
  trigger?: 'mention' | 'all';
  /**
   * The repositories to answer in, as `owner/repo` or `owner/*` for every
   * repository of an owner. Default: every repository that sends events.
   */
  repositories?: string[];
  /** Answer other bots and apps too (default false, so two bots cannot answer each other forever). */
  allowBots?: boolean;
  /**
   * Stream answers into a comment that is edited as the text grows (default
   * false). GitHub notifies subscribers of a comment once, with its first
   * text, and limits how often content may be changed, so answers are sent
   * once finished unless this is on.
   */
  stream?: boolean;
  /** The REST API root, `https://<host>/api/v3` on GitHub Enterprise Server. */
  apiUrl?: string;
  fetch?: typeof fetch;
}

/** A webhook delivery, as any HTTP server hands it over. */
export interface GitHubWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** The body exactly as received, which the signature covers. */
  rawBody?: string | Uint8Array;
}

export interface GitHubWebhookResponse {
  status: number;
  body: string;
}

const MESSAGE_KINDS = ['issue', 'comment', 'review_comment', 'review'] as const;

type MessageKind = (typeof MESSAGE_KINDS)[number];

interface MessageRef {
  kind: MessageKind;
  id: number;
}

interface Conversation {
  owner: string;
  repo: string;
  number: number;
}

/** A header by its name in any letter case, as HTTP header names are. */
function header(headers: GitHubWebhookRequest['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/** Whether `signature` (`sha256=<hex>`) is the HMAC SHA-256 of `body` with `secret`. */
export function verifyGitHubSignature(
  body: string | Uint8Array,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(signature.slice('sha256='.length).toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The JSON of a delivery, sent as `application/json` or as the `payload` field of a form. */
function payloadOf(raw: string | Uint8Array, contentType: string | undefined): unknown {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
  if (contentType?.toLowerCase().includes('application/x-www-form-urlencoded')) {
    const payload = new URLSearchParams(text).get('payload');
    if (payload === null) throw new Error('The form has no payload field');
    return JSON.parse(payload);
  }
  return JSON.parse(text);
}

/** The repository and issue or pull request a `channelId` (`owner/repo#number`) names. */
function parseConversation(channelId: string): Conversation {
  const match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(channelId);
  if (!match) {
    throw new Error(`[github] Unknown channel id "${channelId}": use owner/repo#number`);
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function parseMessageId(messageId: string): MessageRef {
  const match = /^([a-z_]+):(\d+)$/.exec(messageId);
  const kind = MESSAGE_KINDS.find((candidate) => candidate === match?.[1]);
  if (!match || !kind) {
    throw new Error(
      `[github] Unknown message id "${messageId}": use issue:, comment:, review_comment: or review: and a number`
    );
  }
  return { kind, id: Number(match[2]) };
}

function repoPath({ owner, repo }: Conversation): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The review thread a reply goes to: the `topicId`, or the review comment it replies to. */
function reviewThreadOf(options: SendOptions | undefined): number | undefined {
  if (options?.topicId !== undefined) {
    if (!/^\d+$/.test(options.topicId)) {
      throw new Error(
        `[github] Unknown topic "${options.topicId}": use the id of a review thread's first comment`
      );
    }
    return Number(options.topicId);
  }
  if (options?.replyTo?.startsWith('review_comment:')) return parseMessageId(options.replyTo).id;
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text a mention counts in: without code and quoted lines, which only repeat a mention. */
function mentionableText(text: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) fence = marker;
    else if (!/^ {0,3}>/.test(line)) lines.push(line.replace(/`[^`]*`/g, ''));
  }
  return lines.join('\n');
}

/** Keeps a bounded memory: past `MAX_TRACKED` entries the oldest is forgotten. */
function forgetOldest(collection: Set<string> | Map<string, unknown>): void {
  if (collection.size <= MAX_TRACKED) return;
  const oldest = collection.keys().next().value;
  if (oldest !== undefined) collection.delete(oldest);
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BodyTooLarge('Webhook body too large'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * A GitHub channel: an agent answers issues, pull requests, their comments
 * and reviews, in the repositories a webhook sends events from. Each issue or
 * pull request is one conversation, `channelId` `owner/repo#number`, and
 * answers are comments on it. A comment on a line of a pull request is
 * answered in its review thread, which is the message's `topicId` (the id of
 * the thread's first comment), so every review thread is a conversation of
 * its own. Deliveries are checked against the webhook secret, answered at
 * once and handled after.
 */
export class GitHubChannel implements Channel {
  readonly type = 'github';
  readonly editable: boolean;
  readonly nativeMarkdown = true;
  readonly maxMessageChars = GITHUB_COMMENT_LIMIT;
  private readonly config: GitHubChannelConfig;
  private readonly client: GitHubClient;
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private readonly deliveries = new Set<string>();
  private readonly reactions = new Map<string, { id: number; content: string }>();
  private server?: Server;
  private identity?: Promise<string>;
  private botLogin?: string;
  private running = false;

  constructor(config: GitHubChannelConfig) {
    if (!config.webhook?.secret) {
      throw new Error('[github] webhook.secret is required: GitHub signs deliveries with it');
    }
    this.config = config;
    this.editable = config.stream === true;
    this.client = new GitHubClient({
      token: config.token,
      ...(config.apiUrl && { apiUrl: config.apiUrl }),
      ...(config.fetch && { fetch: config.fetch }),
    });
    if (config.login) this.botLogin = config.login;
  }

  /** The bot's login, once known: as configured, or loaded by `start()` or the first delivery. */
  get login(): string | undefined {
    return this.botLogin;
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.identify();
    this.running = true;
    const { port, path, host } = this.config.webhook;
    if (port !== undefined) {
      try {
        await this.listen(port, path ?? '/github/webhook', host);
      } catch (error) {
        this.running = false;
        throw error;
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * Answers a webhook delivery: checks its signature, answers at once and
   * hands the event to the agent after. Mount it in any HTTP server, with the
   * raw body unparsed. It works before `start()` too: the first delivery
   * loads the bot's login when it is not configured. A delivery GitHub sends
   * again (same `X-GitHub-Delivery`) is answered without being handled twice.
   */
  async handleWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse> {
    if (request.method !== 'POST') return { status: 405, body: 'Method not allowed' };
    const raw = request.rawBody ?? '';
    const signature = header(request.headers, 'x-hub-signature-256');
    if (!verifyGitHubSignature(raw, signature, this.config.webhook.secret)) {
      return { status: 401, body: 'Invalid signature' };
    }
    const event = header(request.headers, 'x-github-event');
    if (!event) return { status: 400, body: 'Missing X-GitHub-Event' };
    if (event === 'ping') return { status: 200, body: 'pong' };
    let payload: unknown;
    try {
      payload = payloadOf(raw, header(request.headers, 'content-type'));
    } catch {
      return { status: 400, body: 'Invalid JSON' };
    }
    const delivery = header(request.headers, 'x-github-delivery');
    if (delivery !== undefined && this.deliveries.has(delivery)) {
      return { status: 200, body: 'Already received' };
    }
    if (!isGitHubEventName(event)) return { status: 200, body: 'Ignored' };
    try {
      await this.identify();
    } catch (error) {
      console.error('[github] Could not load the bot login for a webhook delivery:', error);
      return { status: 503, body: 'The bot login could not be loaded' };
    }
    if (delivery !== undefined) {
      if (this.deliveries.has(delivery)) return { status: 200, body: 'Already received' };
      this.deliveries.add(delivery);
      forgetOldest(this.deliveries);
    }
    void this.receive(event, payload).catch((error: unknown) =>
      console.error('[github] Webhook delivery failed:', error)
    );
    return { status: 200, body: 'OK' };
  }

  /**
   * Comments on the issue or pull request of `channelId`, as several
   * comments when the text is longer than GitHub takes. With a `topicId`, or
   * a `replyTo` of a review comment, the comments are replies in that review
   * thread. Resolves with the first comment's id.
   */
  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const conversation = parseConversation(channelId);
    const thread = reviewThreadOf(options);
    const parts = chunkMessage(text, GITHUB_COMMENT_LIMIT).filter((part) => part.trim());
    if (parts.length === 0) throw new Error('[github] Nothing to send');
    const ids: string[] = [];
    for (const part of parts) ids.push(await this.comment(conversation, part, thread));
    return ids[0] ?? '';
  }

  /** Replaces the text of a comment the bot made (`comment:<id>` or `review_comment:<id>`). */
  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const conversation = parseConversation(channelId);
    if (text.length > GITHUB_COMMENT_LIMIT) {
      throw new Error(`[github] A comment holds at most ${GITHUB_COMMENT_LIMIT} characters`);
    }
    await this.client.request('PATCH', this.commentPath(conversation, messageId, 'edited'), {
      body: text,
    });
  }

  /**
   * GitHub has no API to upload files to comments, so a file with a public
   * `url` is sent as a comment that links it (an image shows inline), and a
   * file that only has a `buffer` is refused.
   */
  async sendFile(channelId: string, file: Attachment, options?: SendOptions): Promise<string> {
    if (!file.url || !/^https?:\/\//i.test(file.url)) {
      throw new Error(
        '[github] GitHub has no API to upload files to comments: send a file with a public url'
      );
    }
    const name = (file.filename ?? (file.type === 'image' ? 'image' : 'file')).replace(
      /[[\]]/g,
      ''
    );
    const link = `${file.type === 'image' ? '!' : ''}[${name}](<${file.url}>)`;
    return this.sendText(channelId, file.caption ? `${file.caption}\n\n${link}` : link, options);
  }

  async sendTyping(): Promise<void> {}

  /** Deletes a comment the bot made. */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const conversation = parseConversation(channelId);
    await this.client.request('DELETE', this.commentPath(conversation, messageId, 'deleted'));
  }

  /**
   * Reacts to an issue, pull request or comment, replacing the bot's earlier
   * reaction on it. GitHub has eight reactions (+1, -1, laugh, confused,
   * heart, hooray, rocket, eyes), named or as their emoji, and the status
   * emojis of thinking, a tool and an error become eyes, rocket and
   * confused. Other emojis are skipped, and so are reviews, which take no
   * reactions.
   */
  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const content = REACTIONS[emoji] ?? (REACTION_NAMES.has(emoji) ? emoji : undefined);
    if (!content) return;
    const conversation = parseConversation(channelId);
    const ref = parseMessageId(messageId);
    const path = this.reactionsPath(conversation, ref);
    if (!path) return;
    const key = `${channelId}:${messageId}`;
    const previous = this.reactions.get(key);
    if (previous?.content === content) return;
    const created = ReactionSchema.parse(await this.client.request('POST', path, { content }));
    this.reactions.delete(key);
    this.reactions.set(key, { id: created.id, content });
    forgetOldest(this.reactions);
    if (previous && previous.id !== created.id) {
      await this.client.request('DELETE', `${path}/${previous.id}`);
    }
  }

  private async comment(
    conversation: Conversation,
    body: string,
    thread: number | undefined
  ): Promise<string> {
    const base = repoPath(conversation);
    if (thread !== undefined) {
      const created = CommentSchema.parse(
        await this.client.request(
          'POST',
          `${base}/pulls/${conversation.number}/comments/${thread}/replies`,
          { body }
        )
      );
      return `review_comment:${created.id}`;
    }
    const created = CommentSchema.parse(
      await this.client.request('POST', `${base}/issues/${conversation.number}/comments`, { body })
    );
    return `comment:${created.id}`;
  }

  private commentPath(
    conversation: Conversation,
    messageId: string,
    verb: 'edited' | 'deleted'
  ): string {
    const ref = parseMessageId(messageId);
    const base = repoPath(conversation);
    if (ref.kind === 'comment') return `${base}/issues/comments/${ref.id}`;
    if (ref.kind === 'review_comment') return `${base}/pulls/comments/${ref.id}`;
    throw new Error(`[github] Only comments can be ${verb}, not "${messageId}"`);
  }

  private reactionsPath(conversation: Conversation, ref: MessageRef): string | undefined {
    const base = repoPath(conversation);
    switch (ref.kind) {
      case 'issue':
        return `${base}/issues/${ref.id}/reactions`;
      case 'comment':
        return `${base}/issues/comments/${ref.id}/reactions`;
      case 'review_comment':
        return `${base}/pulls/comments/${ref.id}/reactions`;
      case 'review':
        return undefined;
    }
  }

  private async receive(event: string, payload: unknown): Promise<void> {
    const inbound = githubInboundOf(event, payload);
    if (!inbound || !this.handler) return;
    if (!this.allowsRepository(inbound.repository) || this.skipsSender(inbound.sender)) return;
    if (this.config.trigger !== 'all' && !this.mentionsBot(inbound.text)) return;
    const text = this.stripMention(inbound.text);
    if (!text) return;
    const message: ChannelMessage = {
      id: inbound.id,
      channelType: this.type,
      channelId: `${inbound.repository}#${inbound.number}`,
      userId: String(inbound.sender.id),
      userName: inbound.sender.login,
      groupId: inbound.repository,
      text,
      ...(inbound.replyTo && { replyTo: inbound.replyTo }),
      ...(inbound.topicId && { topicId: inbound.topicId }),
      raw: payload,
    };
    try {
      await this.handler(message);
    } catch (error) {
      console.error('[github] Message handler error:', error);
    }
  }

  /** Loads the bot's login once, unless it is configured. */
  private identify(): Promise<string> {
    if (this.botLogin) return Promise.resolve(this.botLogin);
    this.identity ??= this.client
      .request('GET', '/user')
      .then((user) => {
        const { login } = UserSchema.parse(user);
        this.botLogin = login;
        return login;
      })
      .catch((error: unknown) => {
        this.identity = undefined;
        if (error instanceof FeedError && error.code === 'auth') {
          throw new FeedError(
            'github',
            'auth',
            'GET /user failed: set `login` when the token is a GitHub App installation token',
            { ...(error.status !== undefined && { status: error.status }), cause: error }
          );
        }
        throw error;
      });
    return this.identity;
  }

  private allowsRepository(repository: string): boolean {
    const allowed = this.config.repositories;
    if (!allowed || allowed.length === 0) return true;
    const name = repository.toLowerCase();
    const owner = name.split('/')[0];
    return allowed.some((entry) => {
      const wanted = entry.toLowerCase();
      return wanted === name || wanted === `${owner}/*`;
    });
  }

  private skipsSender(sender: GitHubSender): boolean {
    if (sender.login.toLowerCase() === this.botLogin?.toLowerCase()) return true;
    return sender.type === 'Bot' && this.config.allowBots !== true;
  }

  /** The name people mention the bot by: its login, without `[bot]` for an app. */
  private mentionName(): string | undefined {
    return this.botLogin?.replace(/\[bot\]$/i, '');
  }

  private mentionsBot(text: string): boolean {
    const name = this.mentionName();
    if (!name) return false;
    return new RegExp(`(^|[^\\w/@.-])@${escapeRegExp(name)}(?![\\w-])`, 'i').test(
      mentionableText(text)
    );
  }

  private stripMention(text: string): string {
    const name = this.mentionName();
    const trimmed = text.trim();
    if (!name) return trimmed;
    return (
      trimmed.replace(new RegExp(`^@${escapeRegExp(name)}(?![\\w-])[\\s,:]*`, 'i'), '').trim() ||
      trimmed
    );
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
          this.handleWebhook({ method: req.method ?? 'GET', headers: req.headers, rawBody })
        )
        .then((response) =>
          res.writeHead(response.status, { 'content-type': 'text/plain' }).end(response.body)
        )
        .catch((error: unknown) => {
          if (error instanceof BodyTooLarge) {
            res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
            res.end('Payload too large');
            return;
          }
          console.error('[github] Webhook request failed:', error);
          res.writeHead(500).end();
        });
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => {
        this.server = undefined;
        reject(error);
      };
      server.once('error', failed);
      server.listen(port, host, () => {
        server.off('error', failed);
        resolve();
      });
    });
  }
}

/** A GitHub channel that answers issues, pull requests, comments and reviews. */
export function githubChannel(config: GitHubChannelConfig): GitHubChannel {
  return new GitHubChannel(config);
}
