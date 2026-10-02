/**
 * Message bus for agent-to-agent communication
 */

import { nanoid } from 'nanoid';
import type { MessageBus, MessageBusConfig, SwarmMessage } from '@cogitator-ai/types';
import { invokeSafely } from '../utils/invoke.js';

export type MessageListener = (msg: SwarmMessage) => void;

/**
 * Message bus that remembers which messages each agent has already consumed.
 */
export interface ReadTrackingMessageBus extends MessageBus {
  markAsRead(agentName: string, messageIds: readonly string[]): void;
  resetTurnCounts(agentName?: string): void;
  onMessage(listener: MessageListener): () => void;
}

export function isReadTrackingMessageBus(bus: MessageBus): bus is ReadTrackingMessageBus {
  const candidate = bus as Partial<ReadTrackingMessageBus>;
  return (
    typeof candidate.markAsRead === 'function' &&
    typeof candidate.resetTurnCounts === 'function' &&
    typeof candidate.onMessage === 'function'
  );
}

export function isMessageForAgent(message: SwarmMessage, agentName: string): boolean {
  return (message.to === agentName || message.to === 'broadcast') && message.from !== agentName;
}

/**
 * Shared bookkeeping for message bus implementations: per-turn quotas,
 * per-agent read receipts and bus-wide listeners.
 */
export class MessageBusState {
  private turnCounts = new Map<string, number>();
  private readReceipts = new Map<string, Set<string>>();
  private listeners = new Set<MessageListener>();

  constructor(private readonly label: string) {}

  consumeTurnQuota(config: MessageBusConfig, from: string): void {
    if (!config.maxMessagesPerTurn) return;

    const count = this.turnCounts.get(from) ?? 0;
    if (count >= config.maxMessagesPerTurn) {
      throw new Error(
        `Agent ${from} exceeded max messages per turn (${config.maxMessagesPerTurn})`
      );
    }
    this.turnCounts.set(from, count + 1);
  }

  resetTurnCounts(agentName?: string): void {
    if (agentName === undefined) {
      this.turnCounts.clear();
    } else {
      this.turnCounts.delete(agentName);
    }
  }

  markAsRead(agentName: string, messageIds: readonly string[]): void {
    let receipts = this.readReceipts.get(agentName);
    if (!receipts) {
      receipts = new Set();
      this.readReceipts.set(agentName, receipts);
    }
    for (const id of messageIds) {
      receipts.add(id);
    }
  }

  isRead(agentName: string, messageId: string): boolean {
    return this.readReceipts.get(agentName)?.has(messageId) ?? false;
  }

  forgetMessages(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    for (const receipts of this.readReceipts.values()) {
      for (const id of messageIds) {
        receipts.delete(id);
      }
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notifyListeners(message: SwarmMessage): void {
    for (const listener of [...this.listeners]) {
      invokeSafely(listener, [message], `${this.label} Listener error`);
    }
  }

  clear(): void {
    this.turnCounts.clear();
    this.readReceipts.clear();
  }
}

export function notifyMessageSubscribers(
  subscriptions: Map<string, Set<MessageListener>>,
  message: SwarmMessage,
  label: string
): void {
  if (message.to !== 'broadcast') {
    for (const handler of [...(subscriptions.get(message.to) ?? [])]) {
      invokeSafely(handler, [message], `${label} Handler error`);
    }
    return;
  }

  for (const [agentName, handlers] of subscriptions) {
    if (agentName === message.from) continue;
    for (const handler of [...handlers]) {
      invokeSafely(handler, [message], `${label} Broadcast handler error`);
    }
  }
}

export function addSubscription(
  subscriptions: Map<string, Set<MessageListener>>,
  agentName: string,
  handler: MessageListener
): () => void {
  let handlers = subscriptions.get(agentName);
  if (!handlers) {
    handlers = new Set();
    subscriptions.set(agentName, handlers);
  }
  handlers.add(handler);

  return () => {
    const current = subscriptions.get(agentName);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      subscriptions.delete(agentName);
    }
  };
}

export class InMemoryMessageBus implements ReadTrackingMessageBus {
  private messages: SwarmMessage[] = [];
  private subscriptions = new Map<string, Set<MessageListener>>();
  private config: MessageBusConfig;
  private state = new MessageBusState('[MessageBus]');

  constructor(config: MessageBusConfig) {
    this.config = config;
  }

  async send(message: Omit<SwarmMessage, 'id' | 'timestamp'>): Promise<SwarmMessage> {
    if (!this.config.enabled) {
      throw new Error('Message bus is not enabled');
    }

    if (this.config.maxMessageLength && message.content.length > this.config.maxMessageLength) {
      throw new Error(`Message exceeds max length of ${this.config.maxMessageLength} characters`);
    }

    if (this.config.maxTotalMessages && this.messages.length >= this.config.maxTotalMessages) {
      throw new Error(`Max total messages (${this.config.maxTotalMessages}) reached`);
    }

    this.state.consumeTurnQuota(this.config, message.from);

    const fullMessage: SwarmMessage = {
      ...message,
      id: `msg_${nanoid(12)}`,
      timestamp: Date.now(),
    };

    this.messages.push(fullMessage);
    notifyMessageSubscribers(this.subscriptions, fullMessage, '[MessageBus]');
    this.state.notifyListeners(fullMessage);

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

  subscribe(agentName: string, handler: MessageListener): () => void {
    return addSubscription(this.subscriptions, agentName, handler);
  }

  /**
   * Listen to every message sent through the bus, regardless of recipient.
   */
  onMessage(listener: MessageListener): () => void {
    return this.state.onMessage(listener);
  }

  getMessages(agentName: string, limit?: number): SwarmMessage[] {
    const relevant = this.messages.filter(
      (m) => m.to === agentName || m.to === 'broadcast' || m.from === agentName
    );

    if (limit) {
      return relevant.slice(-limit);
    }
    return relevant;
  }

  getConversation(agent1: string, agent2: string): SwarmMessage[] {
    return this.messages.filter(
      (m) => (m.from === agent1 && m.to === agent2) || (m.from === agent2 && m.to === agent1)
    );
  }

  getAllMessages(): SwarmMessage[] {
    return [...this.messages];
  }

  /**
   * Messages addressed to the agent (directly or via broadcast) that it has not read yet.
   * Use {@link markAsRead} once the messages have been delivered to the agent.
   */
  getUnreadMessages(agentName: string): SwarmMessage[] {
    return this.messages.filter(
      (m) => isMessageForAgent(m, agentName) && !this.state.isRead(agentName, m.id)
    );
  }

  markAsRead(agentName: string, messageIds: readonly string[]): void {
    this.state.markAsRead(agentName, messageIds);
  }

  clear(): void {
    this.messages = [];
    this.state.clear();
  }

  /**
   * Reset per-turn message quotas for one agent, or for all agents when omitted.
   */
  resetTurnCounts(agentName?: string): void {
    this.state.resetTurnCounts(agentName);
  }
}

export function createMessageBus(config?: Partial<MessageBusConfig>): MessageBus {
  return new InMemoryMessageBus({
    enabled: true,
    protocol: 'direct',
    ...config,
  });
}
