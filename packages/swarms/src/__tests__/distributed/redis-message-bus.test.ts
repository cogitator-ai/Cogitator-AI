/**
 * Tests for RedisMessageBus
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisMessageBus } from '../../communication/redis-message-bus.js';

const createMockRedis = () => {
  const subscriptions = new Map<string, (channel: string, message: string) => void>();
  const data = new Map<string, string[]>();

  const mock = {
    duplicate: vi.fn(),
    psubscribe: vi.fn().mockResolvedValue(undefined),
    punsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    off: vi.fn(),
    rpush: vi.fn().mockImplementation((key: string, value: string) => {
      if (!data.has(key)) data.set(key, []);
      data.get(key)!.push(value);
      return Promise.resolve(data.get(key)!.length);
    }),
    lrange: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(data.get(key) ?? []);
    }),
    llen: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(data.get(key)?.length ?? 0);
    }),
    del: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
    on: vi
      .fn()
      .mockImplementation(
        (event: string, handler: (pattern: string, channel: string, message: string) => void) => {
          if (event === 'pmessage') {
            subscriptions.set('pmessage', (ch, msg) => handler('*', ch, msg));
          }
        }
      ),
    _emit: (channel: string, message: string) => {
      const handler = subscriptions.get('pmessage');
      if (handler) handler(channel, message);
    },
    _data: data,
  };

  mock.duplicate.mockReturnValue(mock);

  return mock;
};

describe('RedisMessageBus', () => {
  let bus: RedisMessageBus;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    bus = new RedisMessageBus(
      { enabled: true, protocol: 'direct' },
      { redis: mockRedis as any, swarmId: 'test-swarm', keyPrefix: 'test' }
    );
    await bus.initialize();
  });

  describe('send', () => {
    it('should send a message and return it with id and timestamp', async () => {
      const msg = await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hello',
      });

      expect(msg.id).toBeDefined();
      expect(msg.id).toMatch(/^msg_/);
      expect(msg.from).toBe('agent1');
      expect(msg.to).toBe('agent2');
      expect(msg.content).toBe('Hello');
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it('should push message to Redis', async () => {
      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hello',
      });

      expect(mockRedis.rpush).toHaveBeenCalled();
      expect(mockRedis.publish).toHaveBeenCalled();
    });

    it('should throw when disabled', async () => {
      const disabledBus = new RedisMessageBus(
        { enabled: false, protocol: 'direct' },
        { redis: mockRedis as any, swarmId: 'test-swarm' }
      );

      await expect(
        disabledBus.send({
          swarmId: 'test-swarm',
          from: 'agent1',
          to: 'agent2',
          type: 'request',
          content: 'Hello',
        })
      ).rejects.toThrow('Message bus is not enabled');
    });

    it('should enforce maxMessageLength', async () => {
      const limitedBus = new RedisMessageBus(
        { enabled: true, protocol: 'direct', maxMessageLength: 10 },
        { redis: mockRedis as any, swarmId: 'test-swarm' }
      );

      await expect(
        limitedBus.send({
          swarmId: 'test-swarm',
          from: 'agent1',
          to: 'agent2',
          type: 'request',
          content: 'This is a very long message',
        })
      ).rejects.toThrow('Message exceeds max length');
    });
  });

  describe('getMessages', () => {
    it('should return messages from local cache', async () => {
      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Message 1',
      });

      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent2',
        to: 'agent1',
        type: 'response',
        content: 'Message 2',
      });

      const messages = bus.getMessages('agent2');
      expect(messages.length).toBeGreaterThanOrEqual(1);
    });

    it('should limit messages returned', async () => {
      for (let i = 0; i < 10; i++) {
        await bus.send({
          swarmId: 'test-swarm',
          from: 'agent1',
          to: 'agent2',
          type: 'request',
          content: `Message ${i}`,
        });
      }

      const messages = bus.getMessages('agent2', 5);
      expect(messages).toHaveLength(5);
    });
  });

  describe('getAllMessages', () => {
    it('should return all messages from cache', async () => {
      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Test',
      });

      const all = bus.getAllMessages();
      expect(all.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('broadcast', () => {
    it('should create broadcast message', async () => {
      await bus.broadcast('agent1', 'Hello everyone', 'general');

      const all = bus.getAllMessages();
      const broadcast = all.find((m) => m.to === 'broadcast');
      expect(broadcast).toBeDefined();
      expect(broadcast?.channel).toBe('general');
    });
  });

  describe('subscribe', () => {
    it('should call handler on new messages for agent', async () => {
      const received: string[] = [];

      bus.subscribe('agent2', (msg) => {
        received.push(msg.content);
      });

      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Hello subscriber',
      });

      expect(received).toContain('Hello subscriber');
    });

    it('should allow unsubscription', async () => {
      const received: string[] = [];

      const unsub = bus.subscribe('agent2', (msg) => {
        received.push(msg.content);
      });

      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'First',
      });

      unsub();

      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Second',
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toBe('First');
    });
  });

  describe('clear', () => {
    it('should clear local cache and redis', async () => {
      await bus.send({
        swarmId: 'test-swarm',
        from: 'agent1',
        to: 'agent2',
        type: 'request',
        content: 'Test',
      });

      bus.clear();

      expect(bus.getAllMessages()).toHaveLength(0);
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should unsubscribe and quit subscriber', async () => {
      await bus.close();

      expect(mockRedis.punsubscribe).toHaveBeenCalled();
    });
  });
});
