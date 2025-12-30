/**
 * Swarm messaging tools for agent-to-agent communication
 */

import { z } from 'zod';
import { tool } from '@cogitator/core';
import type { MessageBus } from '@cogitator/types';

/**
 * Create messaging tools bound to a message bus
 */
export function createMessagingTools(messageBus: MessageBus, currentAgent: string) {
  const sendMessage = tool({
    name: 'send_message',
    description: 'Send a message to another agent in the swarm',
    parameters: z.object({
      to: z.string().describe('Name of the recipient agent'),
      message: z.string().describe('The message content to send'),
      channel: z.string().optional().describe('Optional channel for message categorization'),
      waitForReply: z.boolean().optional().describe('Whether to wait for a response (default: false)'),
    }),
    execute: async ({ to, message, channel, waitForReply }) => {
      const msg = await messageBus.send({
        swarmId: '',
        from: currentAgent,
        to,
        type: 'request',
        content: message,
        channel,
      });

      if (waitForReply) {
        const maxWait = 30000;
        const pollInterval = 500;
        let waited = 0;

        while (waited < maxWait) {
          const messages = messageBus.getMessages(currentAgent);
          const reply = messages.find(
            m => m.from === to &&
                 m.type === 'response' &&
                 m.metadata?.correlationId === msg.id
          );

          if (reply) {
            return {
              sent: true,
              messageId: msg.id,
              reply: reply.content,
              replyId: reply.id,
            };
          }

          await new Promise(r => setTimeout(r, pollInterval));
          waited += pollInterval;
        }

        return {
          sent: true,
          messageId: msg.id,
          reply: null,
          timeout: true,
        };
      }

      return {
        sent: true,
        messageId: msg.id,
      };
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
    execute: async ({ limit = 10, from, channel }) => {
      let messages = messageBus.getMessages(currentAgent);

      if (from) {
        messages = messages.filter(m => m.from === from);
      }
      if (channel) {
        messages = messages.filter(m => m.channel === channel);
      }

      messages = messages.slice(0, limit);

      return {
        count: messages.length,
        messages: messages.map(m => ({
          id: m.id,
          from: m.from,
          content: m.content,
          channel: m.channel,
          timestamp: m.timestamp,
          type: m.type,
        })),
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
      await messageBus.broadcast(currentAgent, message, channel);

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
      const allMessages = messageBus.getMessages(currentAgent);
      const original = allMessages.find(m => m.id === originalMessageId);

      if (!original) {
        return {
          success: false,
          error: 'Original message not found',
        };
      }

      const reply = await messageBus.send({
        swarmId: '',
        from: currentAgent,
        to: original.from,
        type: 'response',
        content: message,
        metadata: { correlationId: originalMessageId },
      });

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

export type MessagingTools = ReturnType<typeof createMessagingTools>;
