import type { Agent } from '@atproto/api';
import type { Attachment, Channel, ChannelMessage, SendOptions } from '@cogitator-ai/types';
import { graphemeLength, splitText } from '../../feeds/text';
import { accountOf, type BlueskyAccount } from './account';
import type { BlueskyConnectionConfig } from './config';
import { blueskyError, connectionOf, loadAtproto } from './connection';
import { BlueskyFeed } from './feed';

const CHAT_SERVICE = 'did:web:api.bsky.chat';
const MAX_TRACKED = 1000;
const POST_LIMIT = 300;
const MESSAGE_LIMIT = 1000;
const MAX_NOTIFICATION_PAGES = 10;
const MAX_UNREAD_MESSAGES = 500;

export type BlueskyChannelConfig = ({ account: BlueskyAccount } | BlueskyConnectionConfig) & {
  /** How often to look for mentions, replies and messages, in ms (default 15 000). */
  pollInterval?: number;
  /** Answers mentions, replies and quotes of the account's posts (default true). */
  posts?: boolean;
  /**
   * Answers direct messages (default true). Needs an app password created
   * with "Allow access to your direct messages".
   */
  directMessages?: boolean;
  /** Answers what arrived while the channel was stopped (default true), false starts from now. */
  catchUp?: boolean;
};

interface NotificationPost {
  uri: string;
  cid: string;
  author: { did: string; handle: string; displayName?: string };
  reason: string;
  record: Record<string, unknown>;
  isRead: boolean;
  indexedAt: string;
}

interface ChatMessage {
  $type?: string;
  id: string;
  text?: string;
  sender?: { did: string };
  sentAt?: string;
}

interface Convo {
  id: string;
  unreadCount: number;
  status?: string;
  members: Array<{ did: string; handle: string; displayName?: string }>;
}

/**
 * A conversational Bluesky channel: an agent answers mentions, replies and
 * quotes of its posts in their threads, and direct messages in their
 * conversation. It polls, and keeps what it has seen on Bluesky itself (the
 * notifications' seen time, each conversation's read state), so it needs no
 * state of its own across restarts. Bluesky cannot edit posts, so answers
 * are sent once finished, as a thread of posts or several messages when
 * long. A message's `channelId` is `post:<uri>` to answer under that post,
 * `dm:<convoId>` for a conversation, or `feed` for a new post.
 */
export class BlueskyChannel implements Channel {
  readonly type = 'bluesky';
  readonly editable = false;
  readonly nativeMarkdown = false;
  readonly maxMessageChars = Infinity;
  readonly account: BlueskyAccount;
  private readonly feed: BlueskyFeed;
  private readonly interval: number;
  private readonly posts: boolean;
  private readonly directMessages: boolean;
  private readonly catchUp: boolean;
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private readonly seen = new Map<string, true>();
  private readonly requests = new Set<string>();
  private chatOf?: { agent: Agent; chat: Agent };
  private ownDid?: string;
  private running = false;

  constructor(config: BlueskyChannelConfig) {
    this.account = accountOf(config);
    this.feed = new BlueskyFeed({ account: this.account });
    this.interval = config.pollInterval ?? 15_000;
    this.posts = config.posts ?? true;
    this.directMessages = config.directMessages ?? true;
    this.catchUp = config.catchUp ?? true;
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const agent = await connectionOf(this.account).agent();
    this.ownDid = await this.account.did();
    if (!this.catchUp) await this.skipBacklog(agent);
    this.running = true;
    this.timer = setInterval(() => void this.poll(), this.interval);
    await this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  /** Looks for new mentions, replies and messages once. `start()` does this on a timer. */
  poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        if (this.posts) await this.pollPosts();
        if (this.directMessages) await this.pollMessages();
      } catch (error) {
        console.error('[bluesky] Polling failed:', error);
      }
    })().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const target = parseTarget(channelId);
    if (target.kind === 'dm') return this.sendMessages(target.id, text);
    const parts = splitText(text, POST_LIMIT, graphemeLength);
    if (parts.length === 0) throw new Error('[bluesky] Nothing to send');
    let replyTo = options?.replyTo ?? (target.kind === 'post' ? target.id : undefined);
    let first: string | undefined;
    for (const part of parts) {
      const published = await this.feed.publish({ text: part, ...(replyTo && { replyTo }) });
      first ??= published.id;
      replyTo = published.id;
    }
    return first ?? '';
  }

  editText(): Promise<void> {
    return Promise.reject(new Error('[bluesky] Bluesky posts and messages cannot be edited'));
  }

  async sendFile(channelId: string, file: Attachment, options?: SendOptions): Promise<string> {
    const target = parseTarget(channelId);
    if (target.kind === 'dm') {
      throw new Error('[bluesky] Direct messages cannot carry files: send a link instead');
    }
    const replyTo = options?.replyTo ?? (target.kind === 'post' ? target.id : undefined);
    const published = await this.feed.publish({
      text: file.caption ?? '',
      images: [{ image: file }],
      ...(replyTo && { replyTo }),
    });
    return published.id;
  }

  async sendTyping(): Promise<void> {}

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const target = parseTarget(channelId);
    if (target.kind === 'dm') {
      const chat = await this.chat();
      try {
        await chat.chat.bsky.convo.deleteMessageForSelf({ convoId: target.id, messageId });
      } catch (error) {
        throw blueskyError(error, 'Deleting the message');
      }
      return;
    }
    await this.feed.delete(messageId);
  }

  /** The chat service agent of the current session, made again after a new sign-in. */
  private async chat(): Promise<Agent> {
    const agent = await connectionOf(this.account).agent();
    if (this.chatOf?.agent !== agent) {
      this.chatOf = { agent, chat: agent.withProxy('bsky_chat', CHAT_SERVICE) };
    }
    return this.chatOf.chat;
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

  private async skipBacklog(agent: Agent): Promise<void> {
    try {
      if (this.posts) {
        await agent.app.bsky.notification.updateSeen({ seenAt: new Date().toISOString() });
      }
      if (this.directMessages) await (await this.chat()).chat.bsky.convo.updateAllRead({});
    } catch (error) {
      throw blueskyError(error, 'Skipping what arrived before the start');
    }
  }

  /**
   * Answers the unread mentions, replies and quotes, oldest first, paging back
   * to the first one already seen, then marks them seen.
   */
  private async pollPosts(): Promise<void> {
    const agent = await connectionOf(this.account).agent();
    const unread: NotificationPost[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_NOTIFICATION_PAGES; page++) {
        const response = await agent.app.bsky.notification.listNotifications({
          reasons: ['mention', 'reply', 'quote'],
          limit: 100,
          ...(cursor && { cursor }),
        });
        const notifications = response.data.notifications as NotificationPost[];
        unread.push(...notifications.filter((notification) => !notification.isRead));
        cursor = response.data.cursor;
        if (!cursor || notifications.length === 0 || notifications.some((item) => item.isRead)) {
          cursor = undefined;
          break;
        }
      }
    } catch (error) {
      throw blueskyError(error, 'Listing notifications');
    }
    if (cursor) {
      console.warn(
        `[bluesky] More than ${MAX_NOTIFICATION_PAGES * 100} unread notifications: answering the newest`
      );
    }
    const fresh = unread
      .filter((notification) => notification.author.did !== this.ownDid)
      .sort((a, b) => a.indexedAt.localeCompare(b.indexedAt));
    for (const notification of fresh) {
      if (!this.remember(notification.uri)) continue;
      await this.deliver(this.postMessage(notification));
    }
    const newest = unread
      .map((notification) => notification.indexedAt)
      .sort()
      .at(-1);
    if (newest) {
      try {
        await agent.app.bsky.notification.updateSeen({ seenAt: newest });
      } catch (error) {
        console.error('[bluesky] Could not mark notifications seen:', error);
      }
    }
  }

  private postMessage(notification: NotificationPost): ChannelMessage {
    const record = notification.record;
    const text = typeof record.text === 'string' ? record.text : '';
    const parent = replyParent(record);
    const root = replyRoot(record) ?? notification.uri;
    return {
      id: notification.uri,
      channelType: this.type,
      channelId: `post:${notification.uri}`,
      userId: notification.author.did,
      userName: notification.author.displayName || notification.author.handle,
      groupId: `thread:${root}`,
      text: stripMention(text, this.account.identifier),
      ...(parent && { replyTo: parent }),
      raw: notification,
    };
  }

  private async pollMessages(): Promise<void> {
    const chat = await this.chat();
    let convos: Convo[];
    try {
      const [unread, requests] = await Promise.all([
        chat.chat.bsky.convo.listConvos({ readState: 'unread', limit: 50 }),
        chat.chat.bsky.convo.listConvoRequests({ limit: 50 }),
      ]);
      const pending = (requests.data.requests as Convo[]).filter(
        (convo) => typeof convo.id === 'string' && convo.unreadCount > 0
      );
      for (const convo of pending) this.requests.add(convo.id);
      convos = [...(unread.data.convos as Convo[]), ...pending];
    } catch (error) {
      throw blueskyError(error, 'Listing conversations');
    }
    for (const convo of convos) {
      if (convo.unreadCount <= 0) continue;
      const unread = Math.min(convo.unreadCount, MAX_UNREAD_MESSAGES);
      const messages: ChatMessage[] = [];
      const fromOthers: ChatMessage[] = [];
      try {
        let cursor: string | undefined;
        do {
          const response = await chat.chat.bsky.convo.getMessages({
            convoId: convo.id,
            limit: 100,
            ...(cursor && { cursor }),
          });
          const page = response.data.messages as ChatMessage[];
          messages.push(...page);
          fromOthers.push(
            ...page.filter((message) => message.sender && message.sender.did !== this.ownDid)
          );
          cursor = page.length > 0 ? response.data.cursor : undefined;
        } while (cursor && fromOthers.length < unread);
      } catch (error) {
        console.error(`[bluesky] Could not read conversation ${convo.id}:`, error);
        continue;
      }
      const incoming = fromOthers
        .slice(0, unread)
        .filter((message) => typeof message.text === 'string')
        .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''));
      for (const message of incoming) {
        if (!this.remember(`${convo.id}:${message.id}`)) continue;
        const sender = convo.members.find((member) => member.did === message.sender?.did);
        await this.deliver({
          id: message.id,
          channelType: this.type,
          channelId: `dm:${convo.id}`,
          userId: message.sender?.did ?? '',
          ...(sender && { userName: sender.displayName || sender.handle }),
          text: message.text ?? '',
          raw: { convo, message },
        });
      }
      const newest = messages
        .filter((message) => message.sentAt !== undefined)
        .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))
        .at(-1);
      try {
        await chat.chat.bsky.convo.updateRead({
          convoId: convo.id,
          ...(newest && { messageId: newest.id }),
        });
      } catch (error) {
        console.error(`[bluesky] Could not mark conversation ${convo.id} read:`, error);
      }
    }
  }

  private async sendMessages(convoId: string, text: string): Promise<string> {
    const chat = await this.chat();
    const parts = splitText(text, MESSAGE_LIMIT, graphemeLength);
    if (parts.length === 0) throw new Error('[bluesky] Nothing to send');
    if (this.requests.has(convoId)) {
      try {
        await chat.chat.bsky.convo.acceptConvo({ convoId });
        this.requests.delete(convoId);
      } catch (error) {
        throw blueskyError(error, 'Accepting the conversation');
      }
    }
    const { RichText } = await loadAtproto();
    const agent = await connectionOf(this.account).agent();
    let first: string | undefined;
    for (const part of parts) {
      const rich = new RichText({ text: part });
      try {
        await rich.detectFacets(agent);
        const sent = await chat.chat.bsky.convo.sendMessage({
          convoId,
          message: { text: rich.text, ...(rich.facets?.length ? { facets: rich.facets } : {}) },
        });
        first ??= sent.data.id;
      } catch (error) {
        throw blueskyError(error, 'Sending the message');
      }
    }
    return first ?? '';
  }

  private async deliver(message: ChannelMessage): Promise<void> {
    if (!this.handler || !message.text.trim()) return;
    try {
      await this.handler(message);
    } catch (error) {
      console.error('[bluesky] Message handler error:', error);
    }
  }
}

type Target = { kind: 'post' | 'dm'; id: string } | { kind: 'feed' };

/** What a `channelId` points at: a post to answer, a conversation, or the account's feed. */
function parseTarget(channelId: string): Target {
  if (channelId === 'feed') return { kind: 'feed' };
  if (channelId.startsWith('post:')) return { kind: 'post', id: channelId.slice(5) };
  if (channelId.startsWith('dm:')) return { kind: 'dm', id: channelId.slice(3) };
  if (channelId.startsWith('at://')) return { kind: 'post', id: channelId };
  throw new Error(
    `[bluesky] Unknown channel id "${channelId}": use post:<at-uri>, dm:<convoId> or feed`
  );
}

function strongRefUri(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'uri' in value &&
    typeof value.uri === 'string'
    ? value.uri
    : undefined;
}

function replyParent(record: Record<string, unknown>): string | undefined {
  const reply = record.reply;
  return typeof reply === 'object' && reply !== null && 'parent' in reply
    ? strongRefUri(reply.parent)
    : undefined;
}

function replyRoot(record: Record<string, unknown>): string | undefined {
  const reply = record.reply;
  return typeof reply === 'object' && reply !== null && 'root' in reply
    ? strongRefUri(reply.root)
    : undefined;
}

/** The text without the account's own mention in front, as the agent should read it. */
function stripMention(text: string, identifier: string): string {
  const handle = identifier.replace(/^@/, '').toLowerCase();
  return (
    text
      .replace(
        new RegExp(`^\\s*@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,:]*`, 'i'),
        ''
      )
      .trim() || text.trim()
  );
}

/** A conversational Bluesky channel. */
export function blueskyChannel(config: BlueskyChannelConfig): BlueskyChannel {
  return new BlueskyChannel(config);
}
