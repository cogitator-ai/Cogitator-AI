/**
 * Swarm messaging tools for agent-to-agent communication
 */

import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type {
  Blackboard,
  MessageBus,
  SwarmCoordinatorInterface,
  SwarmMessage,
} from '@cogitator-ai/types';
import { isMessageForAgent, isReadTrackingMessageBus } from '../communication/message-bus.js';
import { readHierarchyPolicy } from '../shared/hierarchy.js';

/**
 * Returns a refusal reason when `from` may not message `to`, or null when allowed.
 */
export type MessageAuthorizer = (to: string | 'broadcast') => string | null;

export interface MessagingToolsOptions {
  /** Restrict who the agent may message (e.g. hierarchical worker isolation) */
  authorize?: MessageAuthorizer;
  /** How long `waitForReply` waits for a correlated response (default: 30000ms) */
  replyTimeout?: number;
}

/**
 * Enforce the hierarchical communication policy published by the hierarchical strategy:
 * workers may only talk to each other when `workerCommunication` is enabled and
 * `routeThrough` is `'direct'`.
 */
export function createHierarchyMessageAuthorizer(
  coordinator: SwarmCoordinatorInterface,
  blackboard: Blackboard,
  currentAgent: string
): MessageAuthorizer {
  return (to) => {
    const policy = readHierarchyPolicy(blackboard);
    if (!policy) return null;

    const isWorker = (name: string) => coordinator.getAgent(name)?.metadata.role === 'worker';
    if (!isWorker(currentAgent)) return null;

    if (to === 'broadcast') {
      return policy.workerCommunication && policy.routeThrough === 'direct'
        ? null
        : `Workers cannot broadcast; send your message to ${policy.supervisor}`;
    }

    if (!isWorker(to)) return null;

    if (!policy.workerCommunication) {
      return `Workers cannot message each other; send your message to ${policy.supervisor}`;
    }
    if (policy.routeThrough !== 'direct') {
      return `Worker messages must be routed through ${policy.supervisor}`;
    }
    return null;
  };
}

function toMessageView(m: SwarmMessage) {
  return {
    id: m.id,
    from: m.from,
    content: m.content,
    channel: m.channel,
    timestamp: m.timestamp,
    type: m.type,
  };
}

export function createMessagingTools(
  messageBus: MessageBus,
  currentAgent: string,
  swarmId = '',
  options: MessagingToolsOptions = {}
) {
  const replyTimeout = options.replyTimeout ?? 30000;

  const markRead = (messages: SwarmMessage[]): void => {
    if (!isReadTrackingMessageBus(messageBus)) return;
    const incoming = messages.filter((m) => isMessageForAgent(m, currentAgent));
    if (incoming.length > 0) {
      messageBus.markAsRead(
        currentAgent,
        incoming.map((m) => m.id)
      );
    }
  };

  const sendMessage = tool({
    name: 'send_message',
    description: 'Send a message to another agent in the swarm',
    parameters: z.object({
      to: z.string().describe('Name of the recipient agent'),
      message: z.string().describe('The message content to send'),
      channel: z.string().optional().describe('Optional channel for message categorization'),
      waitForReply: z
        .boolean()
        .optional()
        .describe('Whether to wait for a response (default: false)'),
    }),
    execute: async ({ to, message, channel, waitForReply }) => {
      if (to === currentAgent) {
        return { sent: false, error: 'You cannot send a message to yourself' };
      }

      const refusal = options.authorize?.(to);
      if (refusal) {
        return { sent: false, error: refusal };
      }

      const msg = await messageBus.send({
        swarmId,
        from: currentAgent,
        to,
        type: 'request',
        content: message,
        channel,
      });

      if (!waitForReply) {
        return { sent: true, messageId: msg.id };
      }

      const reply = await waitForCorrelatedReply(
        messageBus,
        currentAgent,
        to,
        msg.id,
        replyTimeout
      );
      if (!reply) {
        return { sent: true, messageId: msg.id, reply: null, timeout: true };
      }

      markRead([reply]);
      return { sent: true, messageId: msg.id, reply: reply.content, replyId: reply.id };
    },
  });

  const readMessages = tool({
    name: 'read_messages',
    description: 'Read messages sent to you from other agents',
    parameters: z.object({
      limit: z.number().optional().describe('Maximum number of messages to return (default: 10)'),
      from: z.string().optional().describe('Filter by sender agent name'),
      channel: z.string().optional().describe('Filter by channel'),
      unreadOnly: z.boolean().optional().describe('Only return unread messages'),
    }),
    execute: async ({ limit = 10, from, channel, unreadOnly }) => {
      let messages = unreadOnly
        ? messageBus.getUnreadMessages(currentAgent)
        : messageBus.getMessages(currentAgent);

      if (from) {
        messages = messages.filter((m) => m.from === from);
      }
      if (channel) {
        messages = messages.filter((m) => m.channel === channel);
      }

      const count = Math.max(0, Math.floor(limit));
      messages = unreadOnly ? messages.slice(0, count) : count > 0 ? messages.slice(-count) : [];

      markRead(messages);

      return {
        count: messages.length,
        messages: messages.map(toMessageView),
      };
    },
  });

  const broadcastMessage = tool({
    name: 'broadcast_message',
    description: 'Broadcast a message to all agents in the swarm',
    parameters: z.object({
      message: z.string().describe('The message content to broadcast'),
      channel: z.string().optional().describe('Optional channel for message categorization'),
    }),
    execute: async ({ message, channel }) => {
      const refusal = options.authorize?.('broadcast');
      if (refusal) {
        return { broadcasted: false, error: refusal };
      }

      await messageBus.send({
        swarmId,
        from: currentAgent,
        to: 'broadcast',
        type: 'notification',
        content: message,
        channel,
      });

      return {
        broadcasted: true,
        from: currentAgent,
        channel: channel ?? 'default',
      };
    },
  });

  const replyToMessage = tool({
    name: 'reply_to_message',
    description: 'Reply to a specific message',
    parameters: z.object({
      originalMessageId: z.string().describe('ID of the message to reply to'),
      message: z.string().describe('The reply content'),
    }),
    execute: async ({ originalMessageId, message }) => {
      const original = messageBus.getMessages(currentAgent).find((m) => m.id === originalMessageId);

      if (!original) {
        return {
          success: false,
          error: 'Original message not found',
        };
      }

      if (original.from === currentAgent) {
        return { success: false, error: 'You cannot reply to your own message' };
      }

      const refusal = options.authorize?.(original.from);
      if (refusal) {
        return { success: false, error: refusal };
      }

      const reply = await messageBus.send({
        swarmId,
        from: currentAgent,
        to: original.from,
        type: 'response',
        content: message,
        replyTo: originalMessageId,
        correlationId: originalMessageId,
        metadata: { correlationId: originalMessageId },
      });

      markRead([original]);

      return {
        success: true,
        replyId: reply.id,
        to: original.from,
      };
    },
  });

  return {
    sendMessage,
    readMessages,
    broadcastMessage,
    replyToMessage,
  };
}

function isReplyTo(message: SwarmMessage, from: string, requestId: string): boolean {
  if (message.from !== from || message.type !== 'response') return false;
  return (
    message.correlationId === requestId ||
    message.replyTo === requestId ||
    message.metadata?.correlationId === requestId
  );
}

function waitForCorrelatedReply(
  messageBus: MessageBus,
  currentAgent: string,
  from: string,
  requestId: string,
  timeoutMs: number
): Promise<SwarmMessage | null> {
  const existing = messageBus.getMessages(currentAgent).find((m) => isReplyTo(m, from, requestId));
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(null);
    }, timeoutMs);

    const unsubscribe = messageBus.subscribe(currentAgent, (message) => {
      if (!isReplyTo(message, from, requestId)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

export type MessagingTools = ReturnType<typeof createMessagingTools>;
