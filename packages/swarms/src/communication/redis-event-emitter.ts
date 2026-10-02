import { nanoid } from 'nanoid';
import type {
  SwarmEventEmitter,
  SwarmEventType,
  SwarmEvent,
  SwarmEventHandler,
} from '@cogitator-ai/types';
import type { Redis } from 'ioredis';
import { invokeSafely } from '../utils/invoke.js';

export interface RedisEventEmitterOptions {
  redis: Redis;
  swarmId: string;
  keyPrefix?: string;
  maxEvents?: number;
}

interface EventEnvelope {
  _sid: string;
  e: SwarmEvent;
}

const ATOMIC_PUSH_TRIM_SCRIPT = `
local key = KEYS[1]
local maxEvents = tonumber(ARGV[1])
redis.call('RPUSH', key, ARGV[2])
redis.call('LTRIM', key, -maxEvents, -1)
return 1
`;

function parseSwarmEvent(raw: string): SwarmEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SwarmEvent>;
    if (typeof parsed.type !== 'string' || typeof parsed.timestamp !== 'number') return null;
    return parsed as SwarmEvent;
  } catch {
    return null;
  }
}

export class RedisSwarmEventEmitter implements SwarmEventEmitter {
  private redis: Redis;
  private subscriber: Redis;
  private swarmId: string;
  private keyPrefix: string;
  private maxEvents: number;
  private handlers = new Map<SwarmEventType | '*', Set<SwarmEventHandler>>();
  private localEvents: SwarmEvent[] = [];
  private readonly instanceId = nanoid(12);
  private initialized = false;

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

  private readonly handleRemoteEvent = (_channel: string, messageJson: string): void => {
    try {
      const envelope = JSON.parse(messageJson) as EventEnvelope;
      if (envelope._sid === this.instanceId) return;

      this.recordLocally(envelope.e);
      this.notifyHandlers(envelope.e);
    } catch (error) {
      console.warn('[RedisSwarmEventEmitter] Failed to parse message:', error);
    }
  };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.subscriber.on('message', this.handleRemoteEvent);
    try {
      await this.subscriber.subscribe(this.channelKey());
    } catch (error) {
      this.subscriber.off('message', this.handleRemoteEvent);
      this.initialized = false;
      throw error;
    }
  }

  on(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);

    return () => this.off(event, handler);
  }

  once(event: SwarmEventType | '*', handler: SwarmEventHandler): () => void {
    const wrapper: SwarmEventHandler = (e) => {
      this.off(event, wrapper);
      invokeSafely(handler, [e], '[RedisSwarmEventEmitter] Once handler error');
    };
    return this.on(event, wrapper);
  }

  /**
   * Emit an event: local handlers are notified synchronously, persistence and
   * cross-node publication happen in the background.
   */
  emit(event: SwarmEventType, data?: unknown, agentName?: string): void {
    const swarmEvent = this.createEvent(event, data, agentName);
    this.recordLocally(swarmEvent);
    this.notifyHandlers(swarmEvent);

    void this.persistAndPublish(swarmEvent).catch((error: unknown) => {
      console.warn('[RedisSwarmEventEmitter] Emit error:', error);
    });
  }

  /**
   * Emit an event and wait until it is persisted in Redis and published to other nodes.
   */
  async emitAsync(event: SwarmEventType, data?: unknown, agentName?: string): Promise<void> {
    const swarmEvent = this.createEvent(event, data, agentName);
    this.recordLocally(swarmEvent);
    this.notifyHandlers(swarmEvent);

    await this.persistAndPublish(swarmEvent);
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
    const events: SwarmEvent[] = [];
    for (const entry of raw) {
      const parsed = parseSwarmEvent(entry);
      if (parsed) events.push(parsed);
    }
    return events;
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
    this.subscriber.off('message', this.handleRemoteEvent);
    this.initialized = false;
    if (this.subscriber.status === 'end') return;
    if (this.subscriber.status === 'wait') {
      this.subscriber.disconnect();
      return;
    }
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
  }

  private createEvent(event: SwarmEventType, data?: unknown, agentName?: string): SwarmEvent {
    return {
      type: event,
      timestamp: Date.now(),
      agentName,
      data,
    };
  }

  private recordLocally(event: SwarmEvent): void {
    this.localEvents.push(event);
    if (this.localEvents.length > this.maxEvents) {
      this.localEvents = this.localEvents.slice(-this.maxEvents);
    }
  }

  private async persistAndPublish(event: SwarmEvent): Promise<void> {
    await this.redis.eval(
      ATOMIC_PUSH_TRIM_SCRIPT,
      1,
      this.eventsKey(),
      String(this.maxEvents),
      JSON.stringify(event)
    );

    const envelope: EventEnvelope = { _sid: this.instanceId, e: event };
    await this.redis.publish(this.channelKey(), JSON.stringify(envelope));
  }

  private notifyHandlers(event: SwarmEvent): void {
    for (const handler of [...(this.handlers.get(event.type) ?? [])]) {
      invokeSafely(handler, [event], '[RedisSwarmEventEmitter] Handler error');
    }

    for (const handler of [...(this.handlers.get('*') ?? [])]) {
      invokeSafely(handler, [event], '[RedisSwarmEventEmitter] Wildcard handler error');
    }
  }
}
