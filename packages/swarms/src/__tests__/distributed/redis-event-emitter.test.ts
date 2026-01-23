import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SwarmEvent } from '@cogitator-ai/types';
import { RedisSwarmEventEmitter } from '../../communication/redis-event-emitter.js';

function createMockRedis() {
  const data = new Map<string, string[]>();
  const subscribers = new Map<string, ((channel: string, message: string) => void)[]>();
  const eventHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const mock = {
    data,
    subscribers,
    eventHandlers,
    async rpush(key: string, value: string): Promise<number> {
      if (!data.has(key)) {
        data.set(key, []);
      }
      data.get(key)!.push(value);
      return data.get(key)!.length;
    },
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      const arr = data.get(key) ?? [];
      const end = stop === -1 ? arr.length : stop + 1;
      return arr.slice(start, end);
    },
    async llen(key: string): Promise<number> {
      return data.get(key)?.length ?? 0;
    },
    async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
      const arr = data.get(key) ?? [];
      const end = stop === -1 ? arr.length : stop + 1;
      data.set(key, arr.slice(start, end));
      return 'OK';
    },
    async del(key: string): Promise<number> {
      const existed = data.has(key);
      data.delete(key);
      return existed ? 1 : 0;
    },
    async publish(channel: string, message: string): Promise<number> {
      const subs = subscribers.get(channel) ?? [];
      for (const cb of subs) {
        cb(channel, message);
      }
      return subs.length;
    },
    async subscribe(channel: string): Promise<void> {
      if (!subscribers.has(channel)) {
        subscribers.set(channel, []);
      }
    },
    async unsubscribe(): Promise<void> {},
    async quit(): Promise<void> {},
    on(event: string, handler: (...args: unknown[]) => void): typeof mock {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
      return mock;
    },
    duplicate(): typeof mock {
      return mock;
    },
    triggerMessage(channel: string, message: string) {
      const handlers = eventHandlers.get('message') ?? [];
      for (const handler of handlers) {
        handler(channel, message);
      }
    },
  };

  return mock;
}

describe('RedisSwarmEventEmitter', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let emitter: RedisSwarmEventEmitter;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    emitter = new RedisSwarmEventEmitter({
      redis: mockRedis as never,
      swarmId: 'test-swarm',
      keyPrefix: 'test',
      maxEvents: 100,
    });
    await emitter.initialize();
  });

  describe('emit', () => {
    it('should emit event and store in Redis', async () => {
      await emitter.emitAsync('swarm:start', { test: 'data' }, 'agent-1');

      const events = await mockRedis.lrange('test:test-swarm:events', 0, -1);
      expect(events).toHaveLength(1);

      const event = JSON.parse(events[0]) as SwarmEvent;
      expect(event.type).toBe('swarm:start');
      expect(event.data).toEqual({ test: 'data' });
      expect(event.agentName).toBe('agent-1');
      expect(event.timestamp).toBeDefined();
    });

    it('should publish event to channel', async () => {
      const publishSpy = vi.spyOn(mockRedis, 'publish');

      await emitter.emitAsync('agent:complete', { result: 'ok' });

      expect(publishSpy).toHaveBeenCalled();
      const [channel, message] = publishSpy.mock.calls[0];
      expect(channel).toBe('test:test-swarm:events:live');
      const event = JSON.parse(message as string) as SwarmEvent;
      expect(event.type).toBe('agent:complete');
    });

    it('should trim events when exceeding maxEvents', async () => {
      const smallEmitter = new RedisSwarmEventEmitter({
        redis: mockRedis as never,
        swarmId: 'trim-test',
        maxEvents: 3,
      });

      for (let i = 0; i < 5; i++) {
        await smallEmitter.emitAsync('agent:start', { index: i });
      }

      const events = await mockRedis.lrange('swarm:trim-test:events', 0, -1);
      expect(events.length).toBeLessThanOrEqual(3);
    });
  });

  describe('event handlers', () => {
    it('should call handler when event is received', async () => {
      const handler = vi.fn();
      emitter.on('agent:start', handler);

      const event: SwarmEvent = {
        type: 'agent:start',
        timestamp: Date.now(),
        agentName: 'test-agent',
        data: { test: true },
      };

      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'agent:start',
          agentName: 'test-agent',
        })
      );
    });

    it('should call wildcard handler for all events', async () => {
      const handler = vi.fn();
      emitter.on('*', handler);

      const event1: SwarmEvent = { type: 'agent:start', timestamp: Date.now() };
      const event2: SwarmEvent = { type: 'agent:complete', timestamp: Date.now() };

      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event1));
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event2));

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should remove handler with off()', async () => {
      const handler = vi.fn();
      emitter.on('swarm:start', handler);
      emitter.off('swarm:start', handler);

      const event: SwarmEvent = { type: 'swarm:start', timestamp: Date.now() };
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    });

    it('should call once handler only once', async () => {
      const handler = vi.fn();
      emitter.once('swarm:complete', handler);

      const event: SwarmEvent = { type: 'swarm:complete', timestamp: Date.now() };
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));

      await new Promise((r) => setTimeout(r, 20));

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function from on()', async () => {
      const handler = vi.fn();
      const unsubscribe = emitter.on('agent:error', handler);

      unsubscribe();

      const event: SwarmEvent = { type: 'agent:error', timestamp: Date.now() };
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getEvents', () => {
    it('should return local events from cache', async () => {
      const event: SwarmEvent = {
        type: 'agent:start',
        timestamp: Date.now(),
        agentName: 'test',
      };

      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));

      await new Promise((r) => setTimeout(r, 10));

      const events = emitter.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent:start');
    });

    it('should return events from Redis with getEventsAsync', async () => {
      await emitter.emitAsync('swarm:start', {});
      await emitter.emitAsync('agent:start', {}, 'agent-1');

      const events = await emitter.getEventsAsync();
      expect(events).toHaveLength(2);
    });
  });

  describe('event filtering', () => {
    it('should filter events by type', async () => {
      const events: SwarmEvent[] = [
        { type: 'swarm:start', timestamp: 1 },
        { type: 'agent:start', timestamp: 2, agentName: 'a1' },
        { type: 'agent:start', timestamp: 3, agentName: 'a2' },
        { type: 'swarm:complete', timestamp: 4 },
      ];

      for (const e of events) {
        mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(e));
      }

      await new Promise((r) => setTimeout(r, 10));

      const filtered = emitter.getEventsByType('agent:start');
      expect(filtered).toHaveLength(2);
    });

    it('should filter events by agent', async () => {
      const events: SwarmEvent[] = [
        { type: 'agent:start', timestamp: 1, agentName: 'agent-1' },
        { type: 'agent:complete', timestamp: 2, agentName: 'agent-1' },
        { type: 'agent:start', timestamp: 3, agentName: 'agent-2' },
      ];

      for (const e of events) {
        mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(e));
      }

      await new Promise((r) => setTimeout(r, 10));

      const filtered = emitter.getEventsByAgent('agent-1');
      expect(filtered).toHaveLength(2);
    });
  });

  describe('clearEvents', () => {
    it('should clear local events', async () => {
      const event: SwarmEvent = { type: 'swarm:start', timestamp: Date.now() };
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event));

      await new Promise((r) => setTimeout(r, 10));

      emitter.clearEvents();
      expect(emitter.getEvents()).toHaveLength(0);
    });

    it('should clear Redis events with clearEventsAsync', async () => {
      await emitter.emitAsync('swarm:start', {});
      await emitter.emitAsync('agent:start', {});

      await emitter.clearEventsAsync();

      const events = await emitter.getEventsAsync();
      expect(events).toHaveLength(0);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for specific event', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      emitter.on('agent:start', handler1);
      emitter.on('agent:start', handler2);
      emitter.on('agent:complete', handler3);

      emitter.removeAllListeners('agent:start');

      const event1: SwarmEvent = { type: 'agent:start', timestamp: Date.now() };
      const event2: SwarmEvent = { type: 'agent:complete', timestamp: Date.now() };

      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event1));
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event2));

      await new Promise((r) => setTimeout(r, 10));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
    });

    it('should remove all listeners when no event specified', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('agent:start', handler1);
      emitter.on('agent:complete', handler2);

      emitter.removeAllListeners();

      const event1: SwarmEvent = { type: 'agent:start', timestamp: Date.now() };
      const event2: SwarmEvent = { type: 'agent:complete', timestamp: Date.now() };

      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event1));
      mockRedis.triggerMessage('test:test-swarm:events:live', JSON.stringify(event2));

      await new Promise((r) => setTimeout(r, 10));

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });
});
