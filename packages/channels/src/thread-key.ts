import { z } from 'zod';
import type { ChannelMessage } from '@cogitator-ai/types';

/** The fields of a message that say which conversation it belongs to */
export type ConversationRef = Pick<
  ChannelMessage,
  'channelType' | 'channelId' | 'userId' | 'topicId' | 'conversationId'
>;

/**
 * The conversation of a message inside its channel: its `conversationId` when the channel names
 * one, otherwise its chat (`channelId`) and, when it has one, the topic inside it (`topicId`).
 */
export function conversationOf(msg: Omit<ConversationRef, 'channelType' | 'userId'>): string {
  if (msg.conversationId) return msg.conversationId;
  return msg.topicId ? `${msg.channelId}:${msg.topicId}` : msg.channelId;
}

/**
 * The gateway's default thread key: one thread per user per conversation,
 * `channelType:conversation:userId` (see {@link conversationOf}). A user's private chat, each
 * group chat and each forum topic or Slack thread they write in is a thread of its own.
 */
export function defaultThreadKey(msg: ConversationRef): string {
  return `${msg.channelType}:${conversationOf(msg)}:${msg.userId}`;
}

/**
 * The thread key of earlier versions: one thread per user per channel type,
 * `channelType:userId`, whatever chat or topic the message comes from. Pass it as
 * `session.threadKey` to keep the threads a gateway stored before the default changed.
 */
export function legacyThreadKey(msg: Pick<ChannelMessage, 'channelType' | 'userId'>): string {
  return `${msg.channelType}:${msg.userId}`;
}

/**
 * A conversation a user wrote in, kept in the metadata of their session, so the gateway can name
 * its thread again after a restart (`Gateway.compactAll`) and send a scheduled message to it.
 */
export interface StoredConversation {
  channelId: string;
  topicId?: string;
  conversationId?: string;
}

/** The session metadata key that holds a user's conversations, most recent first */
export const CONVERSATIONS_KEY = 'conversations';

/** Conversations kept per session, past it the least recently used one goes */
export const MAX_STORED_CONVERSATIONS = 50;

const StoredConversationSchema = z.object({
  channelId: z.string().min(1),
  topicId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
});

/**
 * The conversations stored in a session's metadata, skipping entries that are not one. Metadata
 * a session store left out reads as none.
 */
export function readConversations(
  metadata: Record<string, unknown> | undefined
): StoredConversation[] {
  const stored = metadata?.[CONVERSATIONS_KEY];
  if (!Array.isArray(stored)) return [];
  const conversations: StoredConversation[] = [];
  for (const entry of stored) {
    const parsed = StoredConversationSchema.safeParse(entry);
    if (parsed.success) conversations.push(parsed.data);
  }
  return conversations;
}

function toStored(msg: Omit<ConversationRef, 'channelType' | 'userId'>): StoredConversation {
  return {
    channelId: msg.channelId,
    ...(msg.topicId && { topicId: msg.topicId }),
    ...(msg.conversationId && { conversationId: msg.conversationId }),
  };
}

function sameEntry(a: StoredConversation, b: StoredConversation): boolean {
  return (
    a.channelId === b.channelId && a.topicId === b.topicId && a.conversationId === b.conversationId
  );
}

/**
 * The conversations with the message's own moved to the front, or `null` when it is already
 * there as it is, so nothing needs to be written. On Bluesky and Threads the entry keeps the
 * conversation's latest post as its `channelId`.
 */
export function rememberConversation(
  conversations: readonly StoredConversation[],
  msg: Omit<ConversationRef, 'channelType' | 'userId'>
): StoredConversation[] | null {
  const entry = toStored(msg);
  const head = conversations[0];
  if (head && sameEntry(head, entry)) return null;
  const key = conversationOf(entry);
  return [entry, ...conversations.filter((c) => conversationOf(c) !== key)].slice(
    0,
    MAX_STORED_CONVERSATIONS
  );
}

/**
 * The stored conversation a message sent to `channelId` without a topic most likely continues:
 * the most recent one in that chat.
 */
export function findConversation(
  conversations: readonly StoredConversation[],
  channelId: string
): StoredConversation | undefined {
  return conversations.find((c) => c.channelId === channelId);
}
