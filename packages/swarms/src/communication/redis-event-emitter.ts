import { nanoid } from 'nanoid';
import type {
  SwarmEventEmitter,
  SwarmEventType,
  SwarmEvent,
  SwarmEventHandler,
} from '@cogitator-ai/types';
import type { Redis } from 'ioredis';

export interface RedisEventEmitterOptions {
  redis: Redis;
  swarmId: string;
  keyPrefix?: string;
  maxEvents?: number;
}

const ATOMIC_PUSH_TRIM_SCRIPT = `
local key = KEYS[1]
local maxEvents = tonumber(ARGV[1])
redis.call('RPUSH', key, ARGV[2])
redis.call('LTRIM', key, -maxEvents, -1)
return 1
`;

export class RedisSwarmEventEmitter implements SwarmEventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private swarmId: string;
  private keyPrefix: string;
  private maxEvents: number;
  private handlers = new Map<SwarmEventType | '*', Set<SwarmEventHandler>>();
  private localEvents: SwarmEvent[] = [];
  private readonly instanceId = nanoid(12);

  constructor(options: RedisEventEmitterOptions) {
    this.redis = options.redis;
    this.subscriber = options.redis.duplicate();
    this.swarmId = options.swarmId;
    this.keyPrefix = options.keyPrefix ?? 'swarm';
    this.maxEvents = options.maxEvents ?? 1000;
  }

  private eventsKey(): string {
    return `${this.keyPrefix}:${this.swarmId}:events`;
  }

  private channelKey(): string {
    return `${this.keyPrefix}:${this.swarmId}:events:live`;
  }

  async initialize(): Promise<void> {
    await this.subscriber.subscribe(this.channelKey());

    this.subscriber.on('message', (_channel, messageJson) => {
      try {
        const envelope = JSON.parse(messageJson) as { _sid: string; e: SwarmEvent };
        if (envelope._sid === this.instanceId) return;

        const event = envelope.e;
        this.localEvents.push(event);
        if (this.localEvents.length > this.maxEvents) {
          this.localEvents = this.localEvents.slice(-this.maxEvents);
        }
        this.notifyHandlers(event);
      } catch (error) {
        console.warn('[RedisSwarmEventEmitter] Failed to parse message:', error);
      }
    });
  }

  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => this.off(event, handler);
  }

  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    const wrapper: SwarmEventHandler = (e) => {
      this.off(event, wrapper);
      void Promise.resolve(handler(e)).catch((error) => {
        console.warn('[RedisSwarmEventEmitter] Once handler error:', error);
      });
    };
    return this.on(event, wrapper);
  }

  emit(event: SwarmEventType, data?: unknown, agentName?: string): void {
    void this.emitAsync(event, data, agentName).catch((error) => {
      console.warn('[RedisSwarmEventEmitter] Emit error:', error);
    });
  }

  async emitAsync(event: SwarmEventType, data?: unknown, agentName?: string): Promise<void> {
    const swarmEvent: SwarmEvent = {
      type: event,
      timestamp: Date.now(),
      agentName,
      data,
    };

    this.localEvents.push(swarmEvent);
    if (this.localEvents.length > this.maxEvents) {
      this.localEvents = this.localEvents.slice(-this.maxEvents);
    }

    const eventJson = JSON.stringify(swarmEvent);

    await this.redis.eval(
      ATOMIC_PUSH_TRIM_SCRIPT,
      1,
      this.eventsKey(),
      String(this.maxEvents),
      eventJson
    );

    const envelope = JSON.stringify({ _sid: this.instanceId, e: swarmEvent });
    await this.redis.publish(this.channelKey(), envelope);
  }

  off(event: SwarmEventType | '*', handler: SwarmEventHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(event);
      }
    }
  }

  removeAllListeners(event?: SwarmEventType): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  getEvents(): SwarmEvent[] {
    return [...this.localEvents];
  }

  async getEventsAsync(): Promise<SwarmEvent[]> {
    const raw = await this.redis.lrange(this.eventsKey(), 0, -1);
    return raw.map((r) => JSON.parse(r) as SwarmEvent);
  }

  getEventsByType(type: SwarmEventType): SwarmEvent[] {
    return this.localEvents.filter((e) => e.type === type);
  }

  getEventsByAgent(agentName: string): SwarmEvent[] {
    return this.localEvents.filter((e) => e.agentName === agentName);
  }

  clearEvents(): void {
    this.localEvents = [];
  }

  async clearEventsAsync(): Promise<void> {
    await this.redis.del(this.eventsKey());
    this.localEvents = [];
  }

  async close(): Promise<void> {
    this.subscriber.removeAllListeners('message');
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
  }

  private notifyHandlers(event: SwarmEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        void Promise.resolve(handler(event)).catch((error) => {
          console.warn('[RedisSwarmEventEmitter] Handler error:', error);
        });
      }
    }

    const wildcardHandlers = this.handlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        void Promise.resolve(handler(event)).catch((error) => {
          console.warn('[RedisSwarmEventEmitter] Wildcard handler error:', error);
        });
      }
    }
  }
}
