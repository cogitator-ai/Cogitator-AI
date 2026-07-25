/**
 * Tests for RedisBlackboard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisBlackboard } from '../../communication/redis-blackboard.js';

const createMockRedis = () => {
  const data = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const subscriptions = new Map<string, (channel: string, message: string) => void>();

  const mock = {
    duplicate: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn().mockImplementation((key: string) => {
      data.delete(key);
      lists.delete(key);
      return Promise.resolve(1);
    }),
    rpush: vi.fn().mockImplementation((key: string, value: string) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(value);
      return Promise.resolve(lists.get(key)!.length);
    }),
    lrange: vi.fn().mockImplementation((key: string) => Promise.resolve(lists.get(key) ?? [])),
    keys: vi.fn().mockImplementation((pattern: string) => {
      const prefix = pattern.replace('*', '');
      const matchingKeys = Array.from(data.keys()).filter((k) => k.startsWith(prefix));
      return Promise.resolve(matchingKeys);
    }),
    publish: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockImplementation((_script: string, _numKeys: number, ...args: string[]) => {
      const sectionKey = args[0];
      const historyKey = args[1];
      const channel = args[2];
      const sectionJson = args[3];
      const notificationJson = args[4];
      const historyEntryJson = args[5];
      const senderId = args[7];

      const section = JSON.parse(sectionJson) as Record<string, unknown>;
      const current = data.get(sectionKey);
      let version = 1;
      if (current) {
        version = ((JSON.parse(current) as Record<string, unknown>).version as number) + 1;
      }
      section.version = version;
      data.set(sectionKey, JSON.stringify(section));

      if (historyEntryJson) {
        const entry = JSON.parse(historyEntryJson) as Record<string, unknown>;
        entry.version = version;
        if (!lists.has(historyKey)) lists.set(historyKey, []);
        lists.get(historyKey)!.push(JSON.stringify(entry));
      }

      const notification = JSON.parse(notificationJson) as Record<string, unknown>;
      notification.version = version;
      notification._sid = senderId;
      const handler = subscriptions.get('message');
      if (handler) handler(channel, JSON.stringify(notification));

      return Promise.resolve(version);
    }),
    on: vi
      .fn()
      .mockImplementation((event: string, handler: (channel: string, message: string) => void) => {
        if (event === 'message') {
          subscriptions.set('message', handler);
        }
      }),
    _emit: (channel: string, message: string) => {
      const handler = subscriptions.get('message');
      if (handler) handler(channel, message);
    },
    _data: data,
  };

  mock.duplicate.mockReturnValue(mock);

  return mock;
};

describe('RedisBlackboard', () => {
  let blackboard: RedisBlackboard;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    blackboard = new RedisBlackboard(
      { enabled: true, sections: { results: [] }, trackHistory: true },
      { redis: mockRedis as any, swarmId: 'test-swarm', keyPrefix: 'test' }
    );
    await blackboard.initialize();
  });

  describe('read', () => {
    it('should read initial section data from cache', () => {
      const results = blackboard.read<unknown[]>('results');
      expect(results).toEqual([]);
    });

    it('should throw for non-existent section', () => {
      expect(() => blackboard.read('nonexistent')).toThrow(
        "Blackboard section 'nonexistent' not found"
      );
    });
  });

  describe('write', () => {
    it('should write data to section', () => {
      blackboard.write('results', ['item1', 'item2'], 'agent1');

      const results = blackboard.read<string[]>('results');
      expect(results).toEqual(['item1', 'item2']);
    });

    it('should persist to redis', () => {
      blackboard.write('results', ['data'], 'agent1');

      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should publish change notification', () => {
      blackboard.write('results', ['data'], 'agent1');

      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should increment version on each write', () => {
      blackboard.write('results', ['v1'], 'agent1');
      blackboard.write('results', ['v2'], 'agent1');

      const section = blackboard.getSection('results');
      expect(section?.version).toBe(3);
    });

    it('should throw when disabled', () => {
      const disabledBB = new RedisBlackboard(
        { enabled: false, sections: {} },
        { redis: mockRedis as any, swarmId: 'test' }
      );

      expect(() => disabledBB.write('test', 'data', 'agent')).toThrow('Blackboard is not enabled');
    });
  });

  describe('append', () => {
    it('should append item to array section', () => {
      blackboard.append('results', 'item1', 'agent1');
      blackboard.append('results', 'item2', 'agent1');

      const results = blackboard.read<string[]>('results');
      expect(results).toEqual(['item1', 'item2']);
    });

    it('should create new array section if not exists', () => {
      blackboard.append('newSection', 'first', 'agent1');

      const section = blackboard.read<string[]>('newSection');
      expect(section).toEqual(['first']);
    });

    it('should throw if section is not array', () => {
      blackboard.write('stringSection', 'not an array', 'agent1');

      expect(() => blackboard.append('stringSection', 'item', 'agent1')).toThrow('is not an array');
    });
  });

  describe('has', () => {
    it('should return true for existing section', () => {
      expect(blackboard.has('results')).toBe(true);
    });

    it('should return false for non-existing section', () => {
      expect(blackboard.has('nonexistent')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should remove section from cache', () => {
      blackboard.delete('results');

      expect(blackboard.has('results')).toBe(false);
    });

    it('should delete from redis', () => {
      blackboard.delete('results');

      expect(mockRedis.del).toHaveBeenCalled();
    });
  });

  describe('getSections', () => {
    it('should return list of section names', () => {
      blackboard.write('another', 'data', 'agent1');

      const sections = blackboard.getSections();
      expect(sections).toContain('results');
      expect(sections).toContain('another');
    });
  });

  describe('getSection', () => {
    it('should return full section metadata', () => {
      blackboard.write('results', ['data'], 'agent1');

      const section = blackboard.getSection('results');
      expect(section).toBeDefined();
      expect(section?.name).toBe('results');
      expect(section?.data).toEqual(['data']);
      expect(section?.modifiedBy).toBe('agent1');
      expect(section?.version).toBeGreaterThan(0);
      expect(section?.lastModified).toBeGreaterThan(0);
    });

    it('should return undefined for non-existing section', () => {
      expect(blackboard.getSection('nonexistent')).toBeUndefined();
    });
  });

  describe('getHistory', () => {
    it('should return history when trackHistory enabled', () => {
      blackboard.write('results', ['v1'], 'agent1');
      blackboard.write('results', ['v2'], 'agent2');

      const history = blackboard.getHistory('results');
      expect(history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('subscribe', () => {
    it('should call handler on section change', () => {
      const changes: unknown[] = [];

      blackboard.subscribe('results', (data) => {
        changes.push(data);
      });

      blackboard.write('results', ['changed'], 'agent1');

      expect(changes).toContainEqual(['changed']);
    });

    it('should allow unsubscription', () => {
      const changes: unknown[] = [];

      const unsub = blackboard.subscribe('results', (data) => {
        changes.push(data);
      });

      blackboard.write('results', ['first'], 'agent1');
      unsub();
      blackboard.write('results', ['second'], 'agent1');

      expect(changes).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('should clear all sections', () => {
      blackboard.write('another', 'data', 'agent1');
      blackboard.clear();

      expect(blackboard.getSections()).toHaveLength(0);
    });
  });

  describe('close', () => {
    it('should unsubscribe and quit', async () => {
      await blackboard.close();

      expect(mockRedis.unsubscribe).toHaveBeenCalled();
    });
  });
});
