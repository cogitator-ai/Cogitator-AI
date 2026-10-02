import { nanoid } from 'nanoid';
import type { MessageBusConfig, SwarmMessage } from '@cogitator-ai/types';
import type { Redis } from 'ioredis';
import {
  MessageBusState,
  addSubscription,
  isMessageForAgent,
  notifyMessageSubscribers,
  type MessageListener,
  type ReadTrackingMessageBus,
} from './message-bus.js';

export interface RedisMessageBusOptions {
  redis: Redis;
  swarmId: string;
  keyPrefix?: string;
}

interface MessageEnvelope {
  _sid: string;
  m: SwarmMessage;
}

function parseSwarmMessage(raw: string): SwarmMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SwarmMessage>;
    if (typeof parsed.id !== 'string' || typeof parsed.from !== 'string') return null;
    return parsed as SwarmMessage;
  } catch {
    return null;
  }
}

export class RedisMessageBus implements ReadTrackingMessageBus {
  private redis: Redis;
  private subscriber: Redis;
  private swarmId: string;
  private keyPrefix: string;
  private config: MessageBusConfig;
  private subscriptions = new Map<string, Set<MessageListener>>();
  private state = new MessageBusState('[RedisMessageBus]');
  private localCache: SwarmMessage[] = [];
  private readonly instanceId = nanoid(12);
  private initialized = false;

  constructor(config: MessageBusConfig, options: RedisMessageBusOptions) {
    this.config = config;
    this.redis = options.redis;
    this.subscriber = options.redis.duplicate();
    this.swarmId = options.swarmId;
    this.keyPrefix = options.keyPrefix ?? 'swarm';
  }

  private messagesKey(): string {
    return `${this.keyPrefix}:${this.swarmId}:messages`;
  }

  private channelKey(target: string): string {
    return `${this.keyPrefix}:${this.swarmId}:channel:${target}`;
  }

  private readonly handleRemoteMessage = (
    _pattern: string,
    _channel: string,
    messageJson: string
  ): void => {
    try {
      const envelope = JSON.parse(messageJson) as MessageEnvelope;
      if (envelope._sid === this.instanceId) return;

      this.appendToCache(envelope.m);
      notifyMessageSubscribers(this.subscriptions, envelope.m, '[RedisMessageBus]');
      this.state.notifyListeners(envelope.m);
    } catch (error) {
      console.warn('[RedisMessageBus] Failed to parse message:', error);
    }
  };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.subscriber.on('pmessage', this.handleRemoteMessage);
    try {
      await this.subscriber.psubscribe(`${this.keyPrefix}:${this.swarmId}:channel:*`);
    } catch (error) {
      this.subscriber.off('pmessage', this.handleRemoteMessage);
      this.initialized = false;
      throw error;
    }
  }

  async send(message: Omit<SwarmMessage, 'id' | 'timestamp'>): Promise<SwarmMessage> {
    if (!this.config.enabled) {
      throw new Error('Message bus is not enabled');
    }

    if (this.config.maxMessageLength && message.content.length > this.config.maxMessageLength) {
      throw new Error(`Message exceeds max length of ${this.config.maxMessageLength} characters`);
    }

    if (this.config.maxTotalMessages && this.localCache.length >= this.config.maxTotalMessages) {
      throw new Error(`Max total messages (${this.config.maxTotalMessages}) reached`);
    }

    this.state.consumeTurnQuota(this.config, message.from);

    const fullMessage: SwarmMessage = {
      ...message,
      swarmId: this.swarmId,
      id: `msg_${nanoid(12)}`,
      timestamp: Date.now(),
    };

    this.appendToCache(fullMessage);
    notifyMessageSubscribers(this.subscriptions, fullMessage, '[RedisMessageBus]');
    this.state.notifyListeners(fullMessage);

    const target = fullMessage.to === 'broadcast' ? 'broadcast' : fullMessage.to;
    const envelope: MessageEnvelope = { _sid: this.instanceId, m: fullMessage };

    await this.redis.rpush(this.messagesKey(), JSON.stringify(fullMessage));
    await this.redis.publish(this.channelKey(target), JSON.stringify(envelope));

    return fullMessage;
  }

  async broadcast(from: string, content: string, channel?: string): Promise<void> {
    await this.send({
      swarmId: this.swarmId,
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

  onMessage(listener: MessageListener): () => void {
    return this.state.onMessage(listener);
  }

  getMessages(agentName: string, limit?: number): SwarmMessage[] {
    const relevant = this.localCache.filter(
      (m) => m.to === agentName || m.to === 'broadcast' || m.from === agentName
    );

    if (limit) {
      return relevant.slice(-limit);
    }
    return relevant;
  }

  getConversation(agent1: string, agent2: string): SwarmMessage[] {
    return this.localCache.filter(
      (m) => (m.from === agent1 && m.to === agent2) || (m.from === agent2 && m.to === agent1)
    );
  }

  getAllMessages(): SwarmMessage[] {
    return [...this.localCache];
  }

  getUnreadMessages(agentName: string): SwarmMessage[] {
    return this.localCache.filter(
      (m) => isMessageForAgent(m, agentName) && !this.state.isRead(agentName, m.id)
    );
  }

  markAsRead(agentName: string, messageIds: readonly string[]): void {
    this.state.markAsRead(agentName, messageIds);
  }

  clear(): void {
    this.localCache = [];
    this.state.clear();
    void this.redis.del(this.messagesKey()).catch((error: unknown) => {
      console.warn('[RedisMessageBus] Clear error:', error);
    });
  }

  resetTurnCounts(agentName?: string): void {
    this.state.resetTurnCounts(agentName);
  }

  async close(): Promise<void> {
    this.subscriber.off('pmessage', this.handleRemoteMessage);
    this.initialized = false;
    if (this.subscriber.status === 'end') return;
    if (this.subscriber.status === 'wait') {
      this.subscriber.disconnect();
      return;
    }
    await this.subscriber.punsubscribe();
    await this.subscriber.quit();
  }

  async syncFromRedis(): Promise<void> {
    const rawMessages = await this.redis.lrange(this.messagesKey(), 0, -1);
    const messages: SwarmMessage[] = [];
    for (const raw of rawMessages) {
      const parsed = parseSwarmMessage(raw);
      if (parsed) {
        messages.push(parsed);
      } else {
        console.warn('[RedisMessageBus] Skipping malformed message in Redis history');
      }
    }
    this.localCache = messages;
    this.trimLocalCache();
  }

  private appendToCache(message: SwarmMessage): void {
    if (this.localCache.some((m) => m.id === message.id)) return;
    this.localCache.push(message);
    this.trimLocalCache();
  }

  private trimLocalCache(): void {
    const max = this.config.maxTotalMessages;
    if (!max || this.localCache.length <= max) return;

    const dropped = this.localCache.slice(0, this.localCache.length - max);
    this.localCache = this.localCache.slice(-max);
    this.state.forgetMessages(dropped.map((m) => m.id));
  }
}
