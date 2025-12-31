/**
 * Message bus for agent-to-agent communication
 */

import { nanoid } from 'nanoid';
import type {
  MessageBus,
  MessageBusConfig,
  SwarmMessage,
} from '@cogitator-ai/types';

export class InMemoryMessageBus implements MessageBus {
  private messages: SwarmMessage[] = [];
  private subscriptions = new Map<string, Set<(msg: SwarmMessage) => void>>();
  private config: MessageBusConfig;
  private agentMessageCounts = new Map<string, number>();

  constructor(config: MessageBusConfig) {
    this.config = config;
  }

  async send(message: Omit<SwarmMessage, 'id' | 'timestamp'>): Promise<SwarmMessage> {
    if (!this.config.enabled) {
      throw new Error('Message bus is not enabled');
    }

    if (
      this.config.maxMessageLength &&
      message.content.length > this.config.maxMessageLength
    ) {
      throw new Error(
        `Message exceeds max length of ${this.config.maxMessageLength} characters`
      );
    }

    if (this.config.maxMessagesPerTurn) {
      const count = this.agentMessageCounts.get(message.from) ?? 0;
      if (count >= this.config.maxMessagesPerTurn) {
        throw new Error(
          `Agent ${message.from} exceeded max messages per turn (${this.config.maxMessagesPerTurn})`
        );
      }
      this.agentMessageCounts.set(message.from, count + 1);
    }

    if (
      this.config.maxTotalMessages &&
      this.messages.length >= this.config.maxTotalMessages
    ) {
      throw new Error(
        `Max total messages (${this.config.maxTotalMessages}) reached`
      );
    }

    const fullMessage: SwarmMessage = {
      ...message,
      id: `msg_${nanoid(12)}`,
      timestamp: Date.now(),
    };

    this.messages.push(fullMessage);
    this.notifySubscribers(fullMessage);

    return fullMessage;
  }

  async broadcast(from: string, content: string, channel?: string): Promise<void> {
    await this.send({
      swarmId: '',
      from,
      to: 'broadcast',
      type: 'notification',
      content,
      channel,
    });
  }

  subscribe(agentName: string, handler: (msg: SwarmMessage) => void): () => void {
    if (!this.subscriptions.has(agentName)) {
      this.subscriptions.set(agentName, new Set());
    }
    this.subscriptions.get(agentName)!.add(handler);

    return () => {
      const handlers = this.subscriptions.get(agentName);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(agentName);
        }
      }
    };
  }

  getMessages(agentName: string, limit?: number): SwarmMessage[] {
    const relevant = this.messages.filter(
      (m) =>
        m.to === agentName ||
        m.to === 'broadcast' ||
        m.from === agentName
    );

    if (limit) {
      return relevant.slice(-limit);
    }
    return relevant;
  }

  getConversation(agent1: string, agent2: string): SwarmMessage[] {
    return this.messages.filter(
      (m) =>
        (m.from === agent1 && m.to === agent2) ||
        (m.from === agent2 && m.to === agent1)
    );
  }

  getAllMessages(): SwarmMessage[] {
    return [...this.messages];
  }

  getUnreadMessages(agentName: string): SwarmMessage[] {
    return this.messages.filter(
      (m) =>
        (m.to === agentName || m.to === 'broadcast') &&
        m.from !== agentName
    );
  }

  clear(): void {
    this.messages = [];
    this.agentMessageCounts.clear();
  }

  resetTurnCounts(): void {
    this.agentMessageCounts.clear();
  }

  private notifySubscribers(message: SwarmMessage): void {
    if (message.to !== 'broadcast') {
      const handlers = this.subscriptions.get(message.to);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message);
          } catch {
          }
        }
      }
    } else {
      for (const [agentName, handlers] of this.subscriptions) {
        if (agentName !== message.from) {
          for (const handler of handlers) {
            try {
              handler(message);
            } catch {
            }
          }
        }
      }
    }
  }
}

export function createMessageBus(config?: Partial<MessageBusConfig>): MessageBus {
  return new InMemoryMessageBus({
    enabled: true,
    protocol: 'direct',
    ...config,
  });
}
