# @cogitator-ai/redis

Unified Redis client for Cogitator with standalone and cluster support.

## Installation

```bash
pnpm add @cogitator-ai/redis ioredis
```

## Features

- **Unified Interface** - Same API for standalone and cluster modes
- **Auto-Detection** - Automatically detect standalone vs cluster
- **Environment Config** - Configure via environment variables
- **TLS Support** - Secure connections with TLS
- **NAT Mapping** - Support for cluster nodes behind NAT
- **Key Prefixing** - Automatic key prefixing with hash tags for cluster
- **Retry Strategy** - Built-in exponential backoff
- **Pub/Sub** - Publish/subscribe support

---

## Quick Start

### Standalone Mode

```typescript
import { createRedisClient } from '@cogitator-ai/redis';

const redis = await createRedisClient({
  url: 'redis://localhost:6379',
});

await redis.set('key', 'value');
const value = await redis.get('key');

await redis.quit();
```

### Cluster Mode

```typescript
import { createRedisClient } from '@cogitator-ai/redis';

const redis = await createRedisClient({
  mode: 'cluster',
  nodes: [
    { host: 'redis-1', port: 6379 },
    { host: 'redis-2', port: 6379 },
    { host: 'redis-3', port: 6379 },
  ],
  keyPrefix: '{cogitator}:',
});

await redis.set('key', 'value');
```

---

## Creating Clients

### Factory Function

```typescript
import { createRedisClient } from '@cogitator-ai/redis';

// Standalone with URL
const client1 = await createRedisClient({
  url: 'redis://localhost:6379',
});

// Standalone with host/port
const client2 = await createRedisClient({
  host: 'localhost',
  port: 6379,
  password: 'secret',
  db: 1,
});

// Cluster mode
const client3 = await createRedisClient({
  mode: 'cluster',
  nodes: [
    { host: 'node1', port: 6379 },
    { host: 'node2', port: 6379 },
    { host: 'node3', port: 6379 },
  ],
});
```

### From Environment Variables

```typescript
import { createRedisClient, createConfigFromEnv } from '@cogitator-ai/redis';

const config = createConfigFromEnv();
const redis = await createRedisClient(config);
```

---

## Configuration

### Standalone Configuration

```typescript
interface RedisStandaloneConfig {
  mode?: 'standalone';

  // Connection
  url?: string; // Redis URL (e.g., redis://localhost:6379)
  host?: string; // Host (alternative to url)
  port?: number; // Port (alternative to url)
  db?: number; // Database number

  // Authentication
  password?: string; // Redis password

  // Options
  keyPrefix?: string; // Prefix for all keys
  tls?: boolean; // Enable TLS
  maxRetriesPerRequest?: number; // Max retries (default: 3)
  lazyConnect?: boolean; // Don't connect immediately
}
```

### Cluster Configuration

```typescript
interface RedisClusterConfig {
  mode: 'cluster';
  nodes: { host: string; port: number }[];

  // Authentication
  password?: string;

  // Options
  keyPrefix?: string; // Use {hashtag}: format for cluster
  tls?: boolean;
  maxRetriesPerRequest?: number;
  lazyConnect?: boolean;

  // Cluster-specific
  scaleReads?: 'master' | 'slave' | 'all'; // Where to read from
  natMap?: Record<string, { host: string; port: number }>; // NAT mapping
}
```

### Configuration Options

| Option                 | Standalone | Cluster | Description             |
| ---------------------- | :--------: | :-----: | ----------------------- |
| `url`                  |     ✓      |    -    | Redis connection URL    |
| `host`                 |     ✓      |    -    | Redis host              |
| `port`                 |     ✓      |    -    | Redis port              |
| `db`                   |     ✓      |    -    | Database number         |
| `nodes`                |     -      |    ✓    | Cluster nodes array     |
| `password`             |     ✓      |    ✓    | Authentication password |
| `keyPrefix`            |     ✓      |    ✓    | Key prefix              |
| `tls`                  |     ✓      |    ✓    | Enable TLS              |
| `maxRetriesPerRequest` |     ✓      |    ✓    | Max retry attempts      |
| `lazyConnect`          |     ✓      |    ✓    | Lazy connection         |
| `scaleReads`           |     -      |    ✓    | Read from replicas      |
| `natMap`               |     -      |    ✓    | NAT address mapping     |

---

## RedisClient Interface

The unified client interface works identically for both modes.

### Key-Value Operations

```typescript
await redis.get('key');

await redis.set('key', 'value');

await redis.setex('key', 3600, 'value');

await redis.del('key1', 'key2');

await redis.expire('key', 3600);

await redis.mget('key1', 'key2', 'key3');
```

### Sorted Sets

```typescript
await redis.zadd('leaderboard', 100, 'player1');
await redis.zadd('leaderboard', 200, 'player2');

const top3 = await redis.zrange('leaderboard', 0, 2);

const highScores = await redis.zrangebyscore('leaderboard', 100, 500);

await redis.zrem('leaderboard', 'player1');
```

### Sets

```typescript
const members = await redis.smembers('myset');
```

### Pub/Sub

```typescript
const subscriber = redis.duplicate();

await subscriber.subscribe('channel', (channel, message) => {
  console.log(`Received on ${channel}: ${message}`);
});

await redis.publish('channel', 'hello');

await subscriber.unsubscribe('channel');
```

### Events

```typescript
redis.on('connect', () => console.log('Connected'));
redis.on('ready', () => console.log('Ready'));
redis.on('error', (err) => console.error('Error:', err));
redis.on('close', () => console.log('Closed'));
redis.on('reconnecting', () => console.log('Reconnecting...'));
redis.on('end', () => console.log('Connection ended'));
```

### Utility Methods

```typescript
await redis.ping();

const info = await redis.info();
const memoryInfo = await redis.info('memory');

const allKeys = await redis.keys('myapp:*');

const sub = redis.duplicate();

await redis.quit();
```

---

## Environment Variables

| Variable              | Description                     |
| --------------------- | ------------------------------- |
| `REDIS_URL`           | Redis connection URL            |
| `REDIS_HOST`          | Redis host (default: localhost) |
| `REDIS_PORT`          | Redis port (default: 6379)      |
| `REDIS_PASSWORD`      | Redis password                  |
| `REDIS_CLUSTER_NODES` | JSON array of cluster nodes     |
| `REDIS_KEY_PREFIX`    | Key prefix                      |

### Environment Examples

**Standalone:**

```bash
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=secret
REDIS_KEY_PREFIX=myapp:
```

**Cluster:**

```bash
REDIS_CLUSTER_NODES='[{"host":"10.0.0.1","port":6379},{"host":"10.0.0.2","port":6379}]'
REDIS_PASSWORD=secret
REDIS_KEY_PREFIX={myapp}:
```

---

## Auto-Detection

Automatically detect if Redis is running in cluster mode:

```typescript
import { createRedisClient, detectRedisMode } from '@cogitator-ai/redis';

const mode = await detectRedisMode({
  host: 'localhost',
  port: 6379,
});

console.log(`Redis mode: ${mode}`);

const config =
  mode === 'cluster'
    ? { mode: 'cluster', nodes: [{ host: 'localhost', port: 6379 }] }
    : { host: 'localhost', port: 6379 };

const redis = await createRedisClient(config);
```

---

## Cluster Key Routing

In cluster mode, use hash tags to ensure related keys route to the same slot:

```typescript
const redis = await createRedisClient({
  mode: 'cluster',
  nodes: [...],
  keyPrefix: '{myapp}:',  // Hash tag prefix
});

// All these keys route to the same slot because of {myapp}
await redis.set('users:123', '...');     // → {myapp}:users:123
await redis.set('sessions:456', '...');  // → {myapp}:sessions:456
```

### Hash Tag Rules

- Use `{hashtag}:` format for prefixes
- Content inside `{}` determines slot routing
- Keys with same hash tag go to same node
- Required for multi-key operations in cluster

---

## TLS Configuration

### Standalone with TLS

```typescript
const redis = await createRedisClient({
  url: 'rediss://secure.redis.host:6379', // Note: rediss://
  tls: true,
});
```

### Cluster with TLS

```typescript
const redis = await createRedisClient({
  mode: 'cluster',
  nodes: [
    { host: 'secure-1.redis.host', port: 6379 },
    { host: 'secure-2.redis.host', port: 6379 },
  ],
  tls: true,
  password: 'secret',
});
```

---

## NAT Mapping

For cluster nodes behind NAT/load balancer:

```typescript
const redis = await createRedisClient({
  mode: 'cluster',
  nodes: [{ host: 'external.host', port: 6379 }],
  natMap: {
    '10.0.0.1:6379': { host: 'external-1.host', port: 6379 },
    '10.0.0.2:6379': { host: 'external-2.host', port: 6379 },
    '10.0.0.3:6379': { host: 'external-3.host', port: 6379 },
  },
});
```

---

## Examples

### Connection Pooling Pattern

```typescript
import { createRedisClient, createConfigFromEnv } from '@cogitator-ai/redis';
import type { RedisClient } from '@cogitator-ai/redis';

let client: RedisClient | null = null;

async function getRedis(): Promise<RedisClient> {
  if (!client) {
    const config = createConfigFromEnv();
    client = await createRedisClient(config);
  }
  return client;
}

async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
```

### Caching Pattern

```typescript
import { createRedisClient } from '@cogitator-ai/redis';

const redis = await createRedisClient({
  url: 'redis://localhost:6379',
  keyPrefix: 'cache:',
});

async function getOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = 3600
): Promise<T> {
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  const data = await fetcher();
  await redis.setex(key, ttl, JSON.stringify(data));
  return data;
}

const user = await getOrFetch('user:123', () => fetchUserFromDb(123), 600);
```

### Pub/Sub Pattern

```typescript
import { createRedisClient } from '@cogitator-ai/redis';

const redis = await createRedisClient({ url: 'redis://localhost:6379' });

const publisher = redis;
const subscriber = redis.duplicate();

interface Event {
  type: string;
  payload: unknown;
}

async function publish(event: Event): Promise<void> {
  await publisher.publish('events', JSON.stringify(event));
}

async function subscribe(handler: (event: Event) => void): Promise<void> {
  await subscriber.subscribe('events', (channel, message) => {
    const event = JSON.parse(message);
    handler(event);
  });
}

await subscribe((event) => {
  console.log('Received event:', event);
});

await publish({ type: 'user.created', payload: { id: 123 } });
```

### Health Check

```typescript
import { createRedisClient } from '@cogitator-ai/redis';

async function checkRedisHealth(): Promise<boolean> {
  const redis = await createRedisClient({
    url: 'redis://localhost:6379',
    lazyConnect: true,
  });

  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  } finally {
    await redis.quit();
  }
}
```

### Graceful Shutdown

```typescript
import { createRedisClient, createConfigFromEnv } from '@cogitator-ai/redis';

const redis = await createRedisClient(createConfigFromEnv());

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await redis.quit();
  process.exit(0);
});
```

---

## Type Reference

```typescript
import type {
  RedisMode,
  RedisNodeConfig,
  RedisCommonOptions,
  RedisStandaloneConfig,
  RedisClusterConfig,
  RedisConfig,
  RedisClient,
} from '@cogitator-ai/redis';

import {
  createRedisClient,
  detectRedisMode,
  parseClusterNodesEnv,
  createConfigFromEnv,
  isClusterConfig,
} from '@cogitator-ai/redis';
```

---

## License

MIT
