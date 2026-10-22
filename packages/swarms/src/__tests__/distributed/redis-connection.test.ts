import { describe, it, expect, vi } from 'vitest';

const created = vi.hoisted(() => ({
  redis: [] as Record<string, unknown>[],
  clusters: [] as { nodes: unknown; options: Record<string, unknown> }[],
}));

vi.mock('ioredis', () => {
  class Redis {
    constructor(readonly options: Record<string, unknown>) {
      created.redis.push(options);
    }
    async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
      return ['0', [`${String(this.options.host)}:${pattern}`]];
    }
  }
  class Cluster {
    constructor(nodes: unknown, options: Record<string, unknown>) {
      created.clusters.push({ nodes, options });
    }
    nodes(): Redis[] {
      return [new Redis({ host: 'm1' }), new Redis({ host: 'm2' })];
    }
  }
  return { Redis, Cluster };
});

describe('distributed swarm connections', () => {
  it('reads a url with credentials, database and TLS, the explicit fields winning', async () => {
    const { resolveRedisOptions } = await import('../../distributed/redis-connection');

    expect(resolveRedisOptions({ url: 'rediss://ann:s%40cret@cache:6380/2', db: 4 })).toEqual({
      host: 'cache',
      port: 6380,
      username: 'ann',
      password: 's@cret',
      db: 4,
      tls: {},
    });
    expect(resolveRedisOptions()).toEqual({ host: 'localhost', port: 6379 });
    expect(() => resolveRedisOptions({ url: 'http://cache' })).toThrow('redis://');
  });

  it('connects to a cluster through its nodes with the credentials of the config', async () => {
    const { createSwarmRedis } = await import('../../distributed/redis-connection');
    created.clusters.length = 0;

    createSwarmRedis(
      { url: 'rediss://:pw@ignored:1', cluster: { nodes: [{ host: 'n1', port: 7000 }] } },
      { blocking: true }
    );

    expect(created.clusters).toEqual([
      {
        nodes: [{ host: 'n1', port: 7000 }],
        options: {
          lazyConnect: true,
          redisOptions: { password: 'pw', tls: {}, maxRetriesPerRequest: null },
        },
      },
    ]);
    expect(() => createSwarmRedis({ cluster: { nodes: [] } })).toThrow('at least one node');
  });

  it('scans every master of a cluster', async () => {
    const { createSwarmRedis, scanSwarmKeys } = await import('../../distributed/redis-connection');

    const keys = await scanSwarmKeys(
      createSwarmRedis({ cluster: { nodes: [{ host: 'n1', port: 7000 }] } }),
      'swarm:{s}:*'
    );

    expect(keys).toEqual(['m1:swarm:{s}:*', 'm2:swarm:{s}:*']);
  });

  it('keeps the queue, the lists of running turns and the heartbeats under one hash tag', async () => {
    const { swarmQueueKeys } = await import('../../distributed/queue-keys');

    const keys = swarmQueueKeys('swarm', 'jobs-a');

    const tag = (key: string) => /\{([^}]*)\}/.exec(key)?.[1];
    expect(keys.queue).toBe('swarm:jobs:{jobs-a}');
    expect(
      [keys.workers, keys.processing('w1'), keys.heartbeat('w1')].map((key) => tag(key))
    ).toEqual(['jobs-a', 'jobs-a', 'jobs-a']);
  });
});
