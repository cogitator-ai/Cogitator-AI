import type { ChannelMessage } from '@cogitator-ai/types';

/**
 * Where a reply to a message goes: its chat and the topic inside it. Only messages with the same
 * destination may be merged into one, or the answer would land in the wrong topic.
 */
export function replyDestination(msg: ChannelMessage): string {
  return `${msg.channelType}:${msg.channelId}:${msg.topicId ?? ''}`;
}

/**
 * Messages of one user to one destination as one message: their texts joined by new lines and
 * all their attachments. It keeps the first message's id and the destination (`topicId`), and
 * `replyTo` of the first message that replies to one. A single message is returned as it is.
 */
export function mergeChannelMessages(messages: readonly ChannelMessage[]): ChannelMessage {
  const first = messages[0];
  if (messages.length === 1) return first;

  const last = messages[messages.length - 1];
  const replyTo = messages.find((m) => m.replyTo !== undefined)?.replyTo;
  const merged: ChannelMessage = {
    id: first.id,
    channelType: first.channelType,
    channelId: first.channelId,
    userId: first.userId,
    userName: first.userName,
    groupId: first.groupId,
    text: messages.map((m) => m.text).join('\n'),
    raw: last.raw,
    ...(first.topicId !== undefined && { topicId: first.topicId }),
    ...(replyTo !== undefined && { replyTo }),
  };

  const attachments = messages.flatMap((m) => m.attachments ?? []);
  if (attachments.length > 0) merged.attachments = attachments;
  return merged;
}

/**
 * A batch of messages merged per destination, in the order the destinations first appear, so
 * messages to different topics or chats are never answered in one place.
 */
export function mergeByDestination(messages: readonly ChannelMessage[]): ChannelMessage[] {
  const groups = new Map<string, ChannelMessage[]>();
  for (const msg of messages) {
    const key = replyDestination(msg);
    groups.set(key, [...(groups.get(key) ?? []), msg]);
  }
  return [...groups.values()].map(mergeChannelMessages);
}
