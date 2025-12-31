import {
  createRedisClient,
  createConfigFromEnv,
  type RedisClient,
} from '@cogitator-ai/redis';

let redis: RedisClient | null = null;
let subscriber: RedisClient | null = null;
let initPromise: Promise<RedisClient> | null = null;
let subscriberPromise: Promise<RedisClient> | null = null;

async function initRedis(): Promise<RedisClient> {
  const config = createConfigFromEnv();
  return createRedisClient(config);
}

export async function getRedis(): Promise<RedisClient> {
  if (redis) return redis;
  if (!initPromise) {
    initPromise = initRedis().then((client) => {
      redis = client;
      return client;
    });
  }
  return initPromise;
}

export async function getSubscriber(): Promise<RedisClient> {
  if (subscriber) return subscriber;
  if (!subscriberPromise) {
    subscriberPromise = initRedis().then((client) => {
      subscriber = client;
      return client;
    });
  }
  return subscriberPromise;
}

export async function publish(channel: string, message: unknown): Promise<void> {
  const client = await getRedis();
  await client.publish(channel, JSON.stringify(message));
}

export async function subscribe(
  channel: string,
  callback: (message: unknown) => void
): Promise<() => void> {
  const sub = await getSubscriber();

  await sub.subscribe(channel);

  const handler = (ch: string, msg: string) => {
    if (ch === channel) {
      try {
        callback(JSON.parse(msg));
      } catch {
        callback(msg);
      }
    }
  };

  sub.on('message', handler);

  return () => {
    sub.off('message', handler);
    sub.unsubscribe(channel);
  };
}

export async function cache<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds = 60
): Promise<T> {
  const client = await getRedis();

  const cached = await client.get(key);
  if (cached) {
    return JSON.parse(cached) as T;
  }

  const result = await fn();
  await client.setex(key, ttlSeconds, JSON.stringify(result));

  return result;
}

export async function invalidateCache(pattern: string): Promise<void> {
  const client = await getRedis();
  const keys = await client.keys(pattern);
  if (keys.length > 0) {
    await client.del(...keys);
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    initPromise = null;
  }
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
    subscriberPromise = null;
  }
}

export const CHANNELS = {
  RUN_STARTED: 'cogitator:run:started',
  RUN_COMPLETED: 'cogitator:run:completed',
  RUN_FAILED: 'cogitator:run:failed',
  LOG_ENTRY: 'cogitator:log:entry',
  AGENT_STATUS: 'cogitator:agent:status',
  TOOL_CALL: 'cogitator:tool:call',
} as const;
