import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis as RealRedis } from 'ioredis';

const created = vi.hoisted(() => [] as RealRedis[]);

vi.mock('ioredis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ioredis')>();
  const Real = actual.Redis;
  function Recording(...args: ConstructorParameters<typeof Real>) {
    const client = new Real(...args);
    created.push(client);
    return client;
  }
  Recording.Cluster = actual.Cluster;
  return { default: Recording, Redis: Recording, Cluster: actual.Cluster };
});

afterEach(() => {
  for (const client of created.splice(0)) client.disconnect();
});

async function optionsFor(config: Parameters<typeof import('../factory').createRedisClient>[0]) {
  const { createRedisClient } = await import('../factory');
  await createRedisClient({ ...config, lazyConnect: true });
  return created.at(-1)!.options;
}

describe('standalone url with explicit fields', () => {
  it('lets explicit db and password win over the url', async () => {
    const options = await optionsFor({
      url: 'redis://:from-url@cache.example:6380/0',
      db: 3,
      password: 'explicit',
    });

    expect(options.db).toBe(3);
    expect(options.password).toBe('explicit');
    expect(options.host).toBe('cache.example');
    expect(options.port).toBe(6380);
  });

  it('lets explicit host and port win over the url', async () => {
    const options = await optionsFor({
      url: 'redis://cache.example:6380/2',
      host: 'h2',
      port: 7000,
    });

    expect(options.host).toBe('h2');
    expect(options.port).toBe(7000);
    expect(options.db).toBe(2);
  });

  it('keeps what the url says when no explicit field overrides it', async () => {
    const options = await optionsFor({ url: 'redis://user:secret@cache.example:6381/5' });

    expect(options).toMatchObject({
      host: 'cache.example',
      port: 6381,
      db: 5,
      username: 'user',
      password: 'secret',
    });
  });
});

describe('config from the environment', () => {
  it('connects to REDIS_URL instead of overriding its host with a default', async () => {
    const { createConfigFromEnv } = await import('../factory');

    const options = await optionsFor(createConfigFromEnv({ REDIS_URL: 'redis://myhost:1234/2' }));

    expect(options).toMatchObject({ host: 'myhost', port: 1234, db: 2 });
  });

  it('lets REDIS_PASSWORD win over the password in REDIS_URL', async () => {
    const { createConfigFromEnv } = await import('../factory');

    const options = await optionsFor(
      createConfigFromEnv({ REDIS_URL: 'redis://:old@myhost:1234', REDIS_PASSWORD: 'rotated' })
    );

    expect(options.password).toBe('rotated');
  });
});
