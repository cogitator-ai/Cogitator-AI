# @cogitator/redis

Unified Redis client for Cogitator with standalone and cluster support.

## Installation

```bash
pnpm add @cogitator/redis ioredis
```

## Usage

### Standalone Mode

```typescript
import { createRedisClient } from '@cogitator/redis';

const redis = await createRedisClient({
  url: 'redis://localhost:6379',
});

await redis.set('key', 'value');
const value = await redis.get('key');
```

### Cluster Mode

```typescript
import { createRedisClient } from '@cogitator/redis';

const redis = await createRedisClient({
  cluster: {
    nodes: [
      { host: 'node1', port: 6379 },
      { host: 'node2', port: 6379 },
      { host: 'node3', port: 6379 },
    ],
  },
});
```

### Environment Configuration

```typescript
import { createConfigFromEnv } from '@cogitator/redis';

// Reads from REDIS_URL, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
// REDIS_CLUSTER_NODES for cluster mode
const config = createConfigFromEnv();
const redis = await createRedisClient(config);
```

### Auto-Detection

```typescript
import { detectRedisMode } from '@cogitator/redis';

// Automatically detects standalone vs cluster
const mode = await detectRedisMode(config);
```

## Environment Variables

- `REDIS_URL` - Redis connection URL
- `REDIS_HOST` - Redis host (alternative to URL)
- `REDIS_PORT` - Redis port (default: 6379)
- `REDIS_PASSWORD` - Redis password
- `REDIS_CLUSTER_NODES` - JSON array of cluster nodes
- `REDIS_KEY_PREFIX` - Key prefix (auto-uses `{cogitator}:` for cluster)

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
