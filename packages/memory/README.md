# @cogitator-ai/memory

Memory adapters for Cogitator AI agents. Supports in-memory, Redis (short-term), and PostgreSQL with pgvector (long-term semantic memory).

## Installation

```bash
pnpm add @cogitator-ai/memory

# Optional peer dependencies
pnpm add ioredis  # For Redis adapter
pnpm add pg       # For PostgreSQL adapter
```

## Usage

### In-Memory Adapter

```typescript
import { InMemoryAdapter } from '@cogitator-ai/memory';

const memory = new InMemoryAdapter();
await memory.saveEntry(threadId, {
  role: 'user',
  content: 'Hello!',
});
```

### Redis Adapter

```typescript
import { RedisAdapter } from '@cogitator-ai/memory';

const memory = new RedisAdapter({
  url: 'redis://localhost:6379',
  ttl: 3600, // 1 hour
});
```

### PostgreSQL Adapter

```typescript
import { PostgresAdapter } from '@cogitator-ai/memory';

const memory = new PostgresAdapter({
  connectionString: 'postgresql://localhost:5432/cogitator',
});
```

### Context Builder

Build token-aware context from memory:

```typescript
import { ContextBuilder } from '@cogitator-ai/memory';

const builder = new ContextBuilder({
  maxTokens: 4000,
  strategy: 'recent',
});

const context = await builder.build(memory, threadId, {
  systemPrompt: 'You are a helpful assistant',
});
```

### Embedding Services

```typescript
import { createEmbeddingService } from '@cogitator-ai/memory';

// OpenAI embeddings
const embeddings = createEmbeddingService('openai', {
  apiKey: process.env.OPENAI_API_KEY,
});

// Ollama embeddings
const embeddings = createEmbeddingService('ollama', {
  model: 'nomic-embed-text',
});
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
