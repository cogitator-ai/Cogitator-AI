import { nanoid } from 'nanoid';
import type { MessageBus, MessageBusConfig, SwarmMessage } from '@cogitator-ai/types';
import type { Redis } from 'ioredis';

export interface RedisMessageBusOptions {
  redis: Redis;
  swarmId: string;
  keyPrefix?: string;
}

export class RedisMessageBus implements MessageBus {
  private redis: Redis;
  private subscriber: Redis;
  private swarmId: string;
  private keyPrefix: string;
  private config: MessageBusConfig;
  private subscriptions = new Map<string, Set<(msg: SwarmMessage) => void>>();
  private agentMessageCounts = new Map<string, number>();
  private localCache: SwarmMessage[] = [];
  private readonly instanceId = nanoid(12);

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

  async initialize(): Promise<void> {
    await this.subscriber.psubscribe(`${this.keyPrefix}:${this.swarmId}:channel:*`);

    this.subscriber.on('pmessage', (_pattern: string, _channel: string, messageJson: string) => {
      try {
        const envelope = JSON.parse(messageJson) as { _sid: string; m: SwarmMessage };
        if (envelope._sid === this.instanceId) return;

        const message = envelope.m;
        this.localCache.push(message);
        this.trimLocalCache();
        this.notifySubscribers(message);
      } catch (error) {
        console.warn('[RedisMessageBus] Failed to parse message:', error);
      }
    });
  }

  async send(message: Omit<SwarmMessage, 'id' | 'timestamp'>): Promise<SwarmMessage> {
    if (!this.config.enabled) {
      throw new Error('Message bus is not enabled');
    }

    if (this.config.maxMessageLength && message.content.length > this.config.maxMessageLength) {
      throw new Error(`Message exceeds max length of ${this.config.maxMessageLength} characters`);
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

    if (this.config.maxTotalMessages && this.localCache.length >= this.config.maxTotalMessages) {
      throw new Error(`Max total messages (${this.config.maxTotalMessages}) reached`);
    }

    const fullMessage: SwarmMessage = {
      ...message,
      swarmId: this.swarmId,
      id: `msg_${nanoid(12)}`,
      timestamp: Date.now(),
    };

    const messageJson = JSON.stringify(fullMessage);
    this.localCache.push(fullMessage);
    this.trimLocalCache();

    this.notifySubscribers(fullMessage);

    void this.redis.rpush(this.messagesKey(), messageJson).catch((error: unknown) => {
      console.warn('[RedisMessageBus] RPUSH error:', error);
    });

    const target = fullMessage.to === 'broadcast' ? 'broadcast' : fullMessage.to;
    const envelope = JSON.stringify({ _sid: this.instanceId, m: fullMessage });
    void this.redis.publish(this.channelKey(target), envelope).catch((error: unknown) => {
      console.warn('[RedisMessageBus] Publish error:', error);
    });

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
      (m) => (m.to === agentName || m.to === 'broadcast') && m.from !== agentName
    );
  }

  clear(): void {
    this.localCache = [];
    this.agentMessageCounts.clear();
    void this.redis.del(this.messagesKey()).catch((error: unknown) => {
      console.warn('[RedisMessageBus] Clear error:', error);
    });
  }

  resetTurnCounts(): void {
    this.agentMessageCounts.clear();
  }

  async close(): Promise<void> {
    await this.subscriber.punsubscribe();
    await this.subscriber.quit();
  }

  async syncFromRedis(): Promise<void> {
    const rawMessages = await this.redis.lrange(this.messagesKey(), 0, -1);
    this.localCache = rawMessages.map((raw) => JSON.parse(raw) as SwarmMessage);
  }

  private trimLocalCache(): void {
    if (this.config.maxTotalMessages && this.localCache.length > this.config.maxTotalMessages) {
      this.localCache = this.localCache.slice(-this.config.maxTotalMessages);
    }
  }

  private notifySubscribers(message: SwarmMessage): void {
    if (message.to !== 'broadcast') {
      const handlers = this.subscriptions.get(message.to);
      if (handlers) {
        for (const handler of handlers) {
          void Promise.resolve(handler(message)).catch((error) => {
            console.warn('[RedisMessageBus] Handler error:', error);
          });
        }
      }
    } else {
      for (const [agentName, handlers] of this.subscriptions) {
        if (agentName !== message.from) {
          for (const handler of handlers) {
            void Promise.resolve(handler(message)).catch((error) => {
              console.warn('[RedisMessageBus] Broadcast handler error:', error);
            });
          }
        }
      }
    }
  }
}
