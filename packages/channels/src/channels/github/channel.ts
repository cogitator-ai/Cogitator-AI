import { verifyGitHubSignature as coreVerifyGitHubSignature } from '@cogitator-ai/core';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { z } from 'zod';
import type { Attachment, Channel, ChannelMessage, SendOptions } from '@cogitator-ai/types';
import { FeedError } from '../../feeds/errors';
import { chunkMessage } from '../../formatters/markdown';
import { GitHubClient, type GitHubToken } from './client';
import {
  githubInboundOf,
  isGitHubEventName,
  type GitHubInbound,
  type GitHubSender,
} from './events';

/** The longest comment GitHub takes, in characters. */
export const GITHUB_COMMENT_LIMIT = 65_536;

const MAX_TRACKED = 1000;
const MAX_BODY = 1024 * 1024;
/** The shortest time between two edits of one comment, under GitHub's limit on content changes. */
export const GITHUB_MIN_EDIT_INTERVAL = 3000;
/** How long to wait before trying to load the bot's login again for a delivery, in ms. */
const IDENTIFY_RETRY_DELAYS = [2000, 10_000];

/** How an author is related to a repository, as GitHub's `author_association` says it. */
export type GitHubAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'MANNEQUIN'
  | 'NONE';

/** The authors the bot answers by default: the repository's owner, the organization's members and collaborators. */
export const GITHUB_TRUSTED_ASSOCIATIONS: readonly GitHubAssociation[] = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
];

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
  /**
   * Run an HTTP server of the channel's own on this port. Without it, mount
   * `handleWebhook` or `webhookListener()` in a server of yours.
   */
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
   * review in the allowed repositories. Once the bot answered someone in a
   * conversation, their next comment there reaches it without a mention (an
   * answer to an approval prompt, a follow-up), and so does every comment in
   * a review thread it replied in.
   */
  trigger?: 'mention' | 'all';
  /**
   * The repositories to answer in, as `owner/repo` or `owner/*` for every
   * repository of an owner. Default: every repository that sends events,
   * which `start()` warns about.
   */
  repositories?: string[];
  /**
   * Whose events the bot answers, by their relation to the repository
   * (`author_association`). Default `OWNER`, `MEMBER` and `COLLABORATOR`,
   * since what people write steers an agent that holds the token. `'any'`
   * answers everyone, for a public bot whose agent has nothing to leak.
   */
  associations?: readonly GitHubAssociation[] | 'any';
  /** Logins the bot answers whatever their association, such as private members of an organization. */
  authors?: string[];
  /** Answer other bots and apps too (default false, so two bots cannot answer each other forever). */
  allowBots?: boolean;
  /**
   * Stream answers into a comment that is edited as the text grows (default
   * false). GitHub notifies subscribers of a comment once, with its first
   * text, and limits how often content may be changed, so answers are sent
   * once finished unless this is on. Edits of one comment are at least
   * `GITHUB_MIN_EDIT_INTERVAL` (3 s) apart, the latest text winning.
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
  return coreVerifyGitHubSignature(body, signature, secret);
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

/**
 * The text a mention counts in: without code (fenced, indented or inline)
 * and quoted lines, which only repeat a mention.
 */
function mentionableText(text: string): string {
  const paragraphs: string[][] = [[]];
  const keep = (line: string) => paragraphs[paragraphs.length - 1].push(line);
  const breakParagraph = () => {
    if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
  };
  let fence: string | undefined;
  let blank = true;
  let indentedCode = false;
  let inList = false;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (!line.trim()) {
      blank = true;
      breakParagraph();
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      indentedCode = indentedCode || (blank && !inList);
      blank = false;
      if (indentedCode) breakParagraph();
      else keep(line);
      continue;
    }
    blank = false;
    indentedCode = false;
    inList = /^ {0,3}([-*+]|\d+[.)])\s/.test(line);
    if (marker) {
      fence = marker;
      breakParagraph();
    } else if (/^ {0,3}>/.test(line)) breakParagraph();
    else keep(line);
  }
  return paragraphs.map((lines) => withoutCodeSpans(lines.join('\n'))).join('\n');
}

/**
 * `text` without its Markdown code spans: a run of backticks opens one that the next run of the
 * same length closes, and a run nothing closes is plain text. Linear in the length of `text`.
 */
function withoutCodeSpans(text: string): string {
  const runs: { start: number; length: number }[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && text[i] === '`') i++;
    runs.push({ start, length: i - start });
  }
  const nextOfLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const indexes = nextOfLength.get(run.length) ?? [];
    indexes.push(index);
    nextOfLength.set(run.length, indexes);
  });
  const cursor = new Map<number, number>();
  let out = '';
  let from = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    if (run.start < from) continue;
    const sameLength = nextOfLength.get(run.length) ?? [];
    let position = cursor.get(run.length) ?? 0;
    while (position < sameLength.length && sameLength[position] <= index) position++;
    cursor.set(run.length, position);
    const closing = sameLength[position];
    if (closing === undefined) continue;
    out += text.slice(from, run.start);
    from = runs[closing].start + run.length;
    index = closing;
  }
  return out + text.slice(from);
}

/** A login without the `[bot]` an app's login ends with, in lower case. */
function loginKey(login: string): string {
  return login.replace(/\[bot\]$/i, '').toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface EditState {
  text: string;
  lastAt: number;
  flight?: Promise<void>;
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
  private readonly handled = new Set<string>();
  private readonly reactions = new Map<string, { id: number; content: string }>();
  private readonly reacting = new Map<string, Promise<void>>();
  private readonly edits = new Map<string, EditState>();
  /** People who wrote to the bot in a conversation and were not answered yet, by conversation. */
  private readonly waiting = new Map<string, Set<string>>();
  /** The conversation and author of each message handed to the agent, by `channelId|messageId`. */
  private readonly askers = new Map<string, { conversation: string; userId: string }>();
  private readonly engaged = new Set<string>();
  private server?: Server;
  private identity?: Promise<string>;
  private botLogin?: string;
  private running = false;
  private stopped = false;

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
    if (!this.config.repositories?.length) {
      console.warn(
        '[github] No repositories set: the bot answers in every repository that sends it events'
      );
    }
    this.running = true;
    this.stopped = false;
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
    this.stopped = true;
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
   * raw body unparsed. It works before `start()` too, and answers `503` once
   * the channel is stopped. A delivery GitHub sends again is handled once:
   * by its `X-GitHub-Delivery` and by the comment, issue or review it
   * carries, which the signature covers. Both are remembered in memory only,
   * for the latest 1000, so a delivery sent again after a restart is
   * handled again.
   */
  async handleWebhook(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse> {
    if (this.stopped) return { status: 503, body: 'The channel is stopped' };
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
    if (!isGitHubEventName(event)) return { status: 200, body: 'Ignored' };
    const delivery = header(request.headers, 'x-github-delivery');
    if (delivery !== undefined) {
      if (this.deliveries.has(delivery)) return { status: 200, body: 'Already received' };
      this.deliveries.add(delivery);
      forgetOldest(this.deliveries);
    }
    void this.receive(event, payload)
      .then((taken) => {
        if (!taken && delivery !== undefined) this.deliveries.delete(delivery);
      })
      .catch((error: unknown) => console.error('[github] Webhook delivery failed:', error));
    return { status: 200, body: 'OK' };
  }

  /**
   * A Node request listener that answers webhook deliveries on any path it
   * is mounted at, such as a route of a server that serves other things too.
   * Bodies over 1 MB are refused with `413`.
   */
  webhookListener(): RequestListener {
    return (req, res) => {
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
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
    };
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
    this.answered(channelId, thread, options?.replyTo);
    return ids[0] ?? '';
  }

  /**
   * Replaces the text of a comment the bot made (`comment:<id>` or
   * `review_comment:<id>`). Edits of one comment go out at least
   * `GITHUB_MIN_EDIT_INTERVAL` apart: an edit made sooner waits, and edits
   * made while it waits are folded into it, the latest text winning.
   */
  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    const conversation = parseConversation(channelId);
    if (text.length > GITHUB_COMMENT_LIMIT) {
      throw new Error(`[github] A comment holds at most ${GITHUB_COMMENT_LIMIT} characters`);
    }
    const path = this.commentPath(conversation, messageId, 'edited');
    const state = this.edits.get(path) ?? { text, lastAt: 0 };
    state.text = text;
    if (!this.edits.has(path)) {
      this.edits.set(path, state);
      forgetOldest(this.edits);
    }
    state.flight ??= this.flushEdit(path, state);
    return state.flight;
  }

  /** Sends the latest text of an edit once the comment's last edit is far enough back. */
  private async flushEdit(path: string, state: EditState): Promise<void> {
    const wait = state.lastAt + GITHUB_MIN_EDIT_INTERVAL - Date.now();
    await (wait > 0 ? sleep(wait) : Promise.resolve());
    state.flight = undefined;
    state.lastAt = Date.now();
    await this.client.request('PATCH', path, { body: state.text });
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
   * reactions. Reactions to one message are set one after another, so the
   * last one called is the one that stays.
   */
  setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    const content = REACTIONS[emoji] ?? (REACTION_NAMES.has(emoji) ? emoji : undefined);
    if (!content) return Promise.resolve();
    const path = this.reactionsPath(parseConversation(channelId), parseMessageId(messageId));
    if (!path) return Promise.resolve();
    const key = `${channelId}:${messageId}`;
    const previous = this.reacting.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.react(key, path, content));
    this.reacting.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.reacting.get(key) === next) this.reacting.delete(key);
      });
    return next;
  }

  private async react(key: string, path: string, content: string): Promise<void> {
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

  /**
   * Notes that the bot answered in a conversation. The person the answer is
   * for (its `replyTo`, or everyone waiting there when it names no message
   * the bot was asked in) may write on without a mention, and in a review
   * thread everyone may.
   */
  private answered(channelId: string, thread: number | undefined, replyTo?: string): void {
    const conversation = thread === undefined ? channelId : `${channelId}:${thread}`;
    if (thread !== undefined) this.remember(this.engaged, conversation);
    const asker = replyTo === undefined ? undefined : this.askers.get(`${channelId}|${replyTo}`);
    if (asker) {
      this.remember(this.engaged, `${asker.conversation}|${asker.userId}`);
      this.waiting.get(asker.conversation)?.delete(asker.userId);
      return;
    }
    for (const userId of this.waiting.get(conversation) ?? []) {
      this.remember(this.engaged, `${conversation}|${userId}`);
    }
    this.waiting.delete(conversation);
  }

  private remember(set: Set<string>, key: string): void {
    set.delete(key);
    set.add(key);
    forgetOldest(set);
  }

  /** Whether a message reaches the bot without a mention: in a conversation it answered. */
  private takesWithoutMention(conversation: string, userId: string): boolean {
    if (this.engaged.has(conversation)) return true;
    return this.engaged.delete(`${conversation}|${userId}`);
  }

  /**
   * Hands a delivery's event to the agent when it is one to answer. Resolves
   * false when the event was dropped because the bot's login could not be
   * loaded or the channel stopped, so the delivery may be sent again.
   */
  private async receive(event: string, payload: unknown): Promise<boolean> {
    const inbound = githubInboundOf(event, payload);
    if (!inbound || !this.handler) return true;
    if (!this.allowsRepository(inbound.repository) || !this.trusts(inbound)) return true;
    if (!(await this.loginForDelivery()) || this.stopped) return false;
    if (this.isOwnOrBot(inbound.sender)) return true;
    const text = this.stripMention(inbound.text);
    if (!text) return true;
    const key = `${inbound.repository.toLowerCase()}:${inbound.id}`;
    if (this.handled.has(key)) return true;
    const channelId = `${inbound.repository}#${inbound.number}`;
    const conversation = inbound.topicId ? `${channelId}:${inbound.topicId}` : channelId;
    const userId = String(inbound.sender.id);
    if (
      this.config.trigger !== 'all' &&
      !this.mentionsBot(inbound.text) &&
      !this.takesWithoutMention(conversation, userId)
    ) {
      return true;
    }
    this.remember(this.handled, key);
    const waiting = this.waiting.get(conversation) ?? new Set<string>();
    waiting.add(userId);
    this.waiting.delete(conversation);
    this.waiting.set(conversation, waiting);
    forgetOldest(this.waiting);
    this.askers.set(`${channelId}|${inbound.id}`, { conversation, userId });
    forgetOldest(this.askers);
    const message: ChannelMessage = {
      id: inbound.id,
      channelType: this.type,
      channelId,
      userId,
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
    return true;
  }

  /**
   * The bot's login for a delivery: loaded when it is not known yet, and
   * tried again a few times, since GitHub does not send a delivery again by
   * itself. The delivery is dropped, with an error logged, when it cannot be
   * loaded.
   */
  private async loginForDelivery(): Promise<string | undefined> {
    let failure: unknown;
    for (const delay of [0, ...IDENTIFY_RETRY_DELAYS]) {
      if (delay > 0) await sleep(delay);
      if (this.stopped) return undefined;
      try {
        return await this.identify();
      } catch (error) {
        failure = error;
      }
    }
    console.error('[github] Could not load the bot login, a delivery was dropped:', failure);
    return undefined;
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

  /** Whether the author may talk to the bot: by their association, or named in `authors`. */
  private trusts(inbound: GitHubInbound): boolean {
    const login = loginKey(inbound.sender.login);
    if (this.config.authors?.some((author) => loginKey(author) === login)) return true;
    const associations = this.config.associations ?? GITHUB_TRUSTED_ASSOCIATIONS;
    return associations === 'any' || associations.some((value) => value === inbound.association);
  }

  private isOwnOrBot(sender: GitHubSender): boolean {
    if (this.botLogin && loginKey(sender.login) === loginKey(this.botLogin)) return true;
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
    const listener = this.webhookListener();
    const server = createServer((req, res) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      if (pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      listener(req, res);
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
