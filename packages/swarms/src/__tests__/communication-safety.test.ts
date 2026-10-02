import { describe, it, expect, vi } from 'vitest';
import { SwarmEventEmitterImpl } from '../communication/event-emitter';
import { InMemoryMessageBus, isReadTrackingMessageBus } from '../communication/message-bus';
import { InMemoryBlackboard } from '../communication/blackboard';
import { RedisSwarmEventEmitter } from '../communication/redis-event-emitter';
import type { Redis } from 'ioredis';

describe('handler isolation', () => {
  it('event emitter keeps notifying after a handler throws synchronously', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitter = new SwarmEventEmitterImpl();
    const after = vi.fn();
    emitter.on('swarm:start', () => {
      throw new Error('bad handler');
    });
    emitter.on('swarm:start', after);
    emitter.on('*', after);

    expect(() => emitter.emit('swarm:start')).not.toThrow();
    expect(after).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('message bus send succeeds when a subscriber throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new InMemoryMessageBus({ enabled: true, protocol: 'direct' });
    bus.subscribe('b', () => {
      throw new Error('subscriber failure');
    });

    await expect(
      bus.send({ swarmId: 's', from: 'a', to: 'b', type: 'request', content: 'hi' })
    ).resolves.toMatchObject({ content: 'hi' });
    warn.mockRestore();
  });

  it('blackboard write succeeds when a subscriber throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const board = new InMemoryBlackboard({ enabled: true, sections: {} });
    board.subscribe('s', () => {
      throw new Error('subscriber failure');
    });

    expect(() => board.write('s', 1, 'a')).not.toThrow();
    expect(board.read('s')).toBe(1);
    warn.mockRestore();
  });
});

describe('InMemoryMessageBus read tracking', () => {
  it('tracks unread messages per agent', async () => {
    const bus = new InMemoryMessageBus({ enabled: true, protocol: 'direct' });
    expect(isReadTrackingMessageBus(bus)).toBe(true);

    const direct = await bus.send({
      swarmId: 's',
      from: 'a',
      to: 'b',
      type: 'request',
      content: 'direct',
    });
    await bus.broadcast('a', 'everyone');

    expect(bus.getUnreadMessages('b').map((m) => m.content)).toEqual(['direct', 'everyone']);
    expect(bus.getUnreadMessages('c').map((m) => m.content)).toEqual(['everyone']);
    expect(bus.getUnreadMessages('a')).toHaveLength(0);

    bus.markAsRead('b', [direct.id]);
    expect(bus.getUnreadMessages('b').map((m) => m.content)).toEqual(['everyone']);
    expect(bus.getUnreadMessages('c')).toHaveLength(1);
  });

  it('does not consume a turn quota for rejected messages', async () => {
    const bus = new InMemoryMessageBus({
      enabled: true,
      protocol: 'direct',
      maxMessagesPerTurn: 1,
      maxTotalMessages: 1,
    });

    await bus.send({ swarmId: 's', from: 'x', to: 'y', type: 'request', content: '1' });
    await expect(
      bus.send({ swarmId: 's', from: 'z', to: 'y', type: 'request', content: '2' })
    ).rejects.toThrow('Max total messages');

    bus.clear();
    await expect(
      bus.send({ swarmId: 's', from: 'z', to: 'y', type: 'request', content: '3' })
    ).resolves.toBeDefined();
  });

  it('resets turn quotas for a single agent', async () => {
    const bus = new InMemoryMessageBus({
      enabled: true,
      protocol: 'direct',
      maxMessagesPerTurn: 1,
    });
    await bus.send({ swarmId: 's', from: 'a', to: 'b', type: 'request', content: '1' });
    await bus.send({ swarmId: 's', from: 'c', to: 'b', type: 'request', content: '1' });

    bus.resetTurnCounts('a');

    await expect(
      bus.send({ swarmId: 's', from: 'a', to: 'b', type: 'request', content: '2' })
    ).resolves.toBeDefined();
    await expect(
      bus.send({ swarmId: 's', from: 'c', to: 'b', type: 'request', content: '2' })
    ).rejects.toThrow('exceeded max messages per turn');
  });
});

describe('InMemoryBlackboard', () => {
  it('keeps subscriptions across clear()', () => {
    const board = new InMemoryBlackboard({ enabled: true, sections: {} });
    const handler = vi.fn();
    board.subscribe('plan', handler);

    board.clear();
    board.write('plan', 'v2', 'a');

    expect(handler).toHaveBeenCalledWith('v2', 'a');
  });

  it('reports deletions to write listeners', () => {
    const board = new InMemoryBlackboard({ enabled: true, sections: { plan: 1 } });
    const listener = vi.fn();
    board.onWrite(listener);

    board.delete('plan');

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'plan', deleted: true })
    );
  });

  it('returns a copy of the history', () => {
    const board = new InMemoryBlackboard({ enabled: true, sections: {}, trackHistory: true });
    board.write('s', 1, 'a');
    board.getHistory('s').pop();
    expect(board.getHistory('s')).toHaveLength(1);
  });
});

describe('RedisSwarmEventEmitter', () => {
  function createRedisStub() {
    const listeners = new Map<string, ((...args: string[]) => void)[]>();
    const stub = {
      status: 'ready',
      eval: vi.fn().mockResolvedValue(1),
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      on: vi.fn((event: string, handler: (...args: string[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return stub;
      }),
      off: vi.fn((event: string, handler: (...args: string[]) => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((h) => h !== handler)
        );
        return stub;
      }),
      duplicate: () => stub,
      listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
    };
    return stub;
  }

  it('notifies local handlers synchronously on emit', () => {
    const redis = createRedisStub();
    const emitter = new RedisSwarmEventEmitter({
      redis: redis as unknown as Redis,
      swarmId: 's',
    });
    const handler = vi.fn();
    emitter.on('agent:start', handler);

    emitter.emit('agent:start', { agentName: 'a' }, 'a');

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent:start' }));
    expect(emitter.getEvents()).toHaveLength(1);
  });

  it('subscribes only once even when initialize is called repeatedly', async () => {
    const redis = createRedisStub();
    const emitter = new RedisSwarmEventEmitter({
      redis: redis as unknown as Redis,
      swarmId: 's',
    });

    await emitter.initialize();
    await emitter.initialize();

    expect(redis.subscribe).toHaveBeenCalledTimes(1);
    expect(redis.listenerCount('message')).toBe(1);

    await emitter.close();
    expect(redis.listenerCount('message')).toBe(0);
  });
});
