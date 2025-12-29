# Memory System

> Hybrid memory architecture for persistent, intelligent context management

## Overview

Cogitator's memory system is designed to solve the fundamental challenge of LLM context limitations while maintaining fast retrieval and intelligent relevance ranking.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Memory Manager                                      │
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         Memory Router                                   │   │
│   │                                                                         │   │
│   │  Input ──► Classify ──► Route ──► Store/Retrieve ──► Output            │   │
│   │                                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                      │                                          │
│              ┌───────────────────────┼───────────────────────┐                  │
│              ▼                       ▼                       ▼                  │
│   ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐          │
│   │  Working Memory │     │  Episodic Memory│     │  Semantic Memory│          │
│   │     (L1)        │     │     (L2/L3)     │     │     (L4)        │          │
│   │                 │     │                 │     │                 │          │
│   │  • In-process   │     │  • Redis (L2)   │     │  • pgvector     │          │
│   │  • Current ctx  │     │  • Postgres (L3)│     │  • Embeddings   │          │
│   │  • Fast access  │     │  • Conversations│     │  • RAG          │          │
│   └─────────────────┘     └─────────────────┘     └─────────────────┘          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Memory Types

### 1. Working Memory (L1)

In-process cache for current execution context.

```typescript
interface WorkingMemory {
  // Current conversation messages
  messages: Message[];

  // Active tool call results
  toolResults: Map<string, ToolResult>;

  // Scratchpad for agent reasoning
  scratchpad: string;

  // Token count
  tokenCount: number;
}

class WorkingMemoryManager {
  private cache: LRUCache<string, WorkingMemory>;

  constructor() {
    this.cache = new LRUCache({
      max: 1000, // Max 1000 agents in memory
      maxSize: 500_000_000, // 500MB total
      sizeCalculation: (memory) => this.estimateSize(memory),
      ttl: 1000 * 60 * 30, // 30 minutes TTL
    });
  }

  get(agentId: string): WorkingMemory {
    let memory = this.cache.get(agentId);
    if (!memory) {
      memory = this.createEmpty();
      this.cache.set(agentId, memory);
    }
    return memory;
  }

  append(agentId: string, message: Message): void {
    const memory = this.get(agentId);
    memory.messages.push(message);
    memory.tokenCount += this.countTokens(message);

    // Auto-flush to L2 if too large
    if (memory.tokenCount > 32_000) {
      this.flushToEpisodic(agentId);
    }
  }
}
```

### 2. Episodic Memory (L2/L3)

Conversation history with temporal awareness.

```typescript
interface EpisodicMemory {
  id: string;
  agentId: string;
  threadId: string;
  type: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  timestamp: Date;
  metadata: {
    importance: number; // 0-1, affects retrieval priority
    tokens: number;
    toolCalls?: ToolCall[];
    model?: string;
  };
}

// Redis schema (L2 - short term)
// Key: episodic:{agentId}:{threadId}
// Type: Sorted Set (score = timestamp)

// Postgres schema (L3 - long term)
const episodicMemorySchema = `
  CREATE TABLE episodic_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    thread_id UUID NOT NULL,
    type VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    importance FLOAT DEFAULT 0.5,
    tokens INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Indexes for fast retrieval
    INDEX idx_agent_thread (agent_id, thread_id),
    INDEX idx_agent_time (agent_id, created_at DESC),
    INDEX idx_importance (agent_id, importance DESC)
  );
`;
```

### 3. Semantic Memory (L4)

Vector embeddings for similarity-based retrieval.

```typescript
interface SemanticMemory {
  id: string;
  agentId: string;
  content: string;
  embedding: number[]; // 1536 dimensions (OpenAI) or 384 (local)
  type: 'fact' | 'preference' | 'skill' | 'document';
  source: string; // Where this knowledge came from
  confidence: number; // How confident we are in this info
  lastAccessed: Date; // For LRU-style eviction
  metadata: Record<string, any>;
}

// pgvector schema
const semanticMemorySchema = `
  CREATE TABLE semantic_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    content TEXT NOT NULL,
    embedding vector(1536),  -- or vector(384) for local models
    type VARCHAR(20) NOT NULL,
    source TEXT,
    confidence FLOAT DEFAULT 1.0,
    last_accessed TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- HNSW index for fast similarity search
    INDEX idx_embedding USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  );
`;
```

---

## Retrieval Strategies

### Strategy 1: Recency

Retrieve most recent memories first.

```typescript
async function retrieveByRecency(agentId: string, limit: number): Promise<EpisodicMemory[]> {
  // First check Redis (L2)
  const recentKeys = await redis.zrevrange(`episodic:${agentId}:*`, 0, limit - 1);

  if (recentKeys.length >= limit) {
    return Promise.all(recentKeys.map((k) => redis.hgetall(k)));
  }

  // Fall back to Postgres (L3)
  const remaining = limit - recentKeys.length;
  const dbResults = await db.query(
    `
    SELECT * FROM episodic_memories
    WHERE agent_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `,
    [agentId, remaining]
  );

  return [...recentKeys, ...dbResults.rows];
}
```

### Strategy 2: Semantic Similarity

Retrieve memories most similar to a query.

```typescript
async function retrieveBySimilarity(
  agentId: string,
  query: string,
  limit: number
): Promise<SemanticMemory[]> {
  // 1. Generate embedding for query
  const embedding = await embedder.embed(query);

  // 2. Search pgvector
  const results = await db.query(
    `
    SELECT *,
           1 - (embedding <=> $1) as similarity
    FROM semantic_memories
    WHERE agent_id = $2
    ORDER BY embedding <=> $1
    LIMIT $3
  `,
    [pgvector.toSql(embedding), agentId, limit]
  );

  return results.rows;
}
```

### Strategy 3: Importance-Weighted

Prioritize memories marked as important.

```typescript
async function retrieveByImportance(agentId: string, limit: number): Promise<EpisodicMemory[]> {
  return db.query(
    `
    SELECT * FROM episodic_memories
    WHERE agent_id = $1
    ORDER BY importance DESC, created_at DESC
    LIMIT $2
  `,
    [agentId, limit]
  );
}
```

### Strategy 4: Hybrid (Recommended)

Combine multiple strategies with weighted scoring.

```typescript
interface HybridRetrievalConfig {
  recencyWeight: number; // 0-1
  similarityWeight: number; // 0-1
  importanceWeight: number; // 0-1
}

async function retrieveHybrid(
  agentId: string,
  query: string,
  limit: number,
  config: HybridRetrievalConfig = {
    recencyWeight: 0.3,
    similarityWeight: 0.5,
    importanceWeight: 0.2,
  }
): Promise<Memory[]> {
  // 1. Get candidates from all strategies (3x limit for reranking)
  const candidateLimit = limit * 3;

  const [recentMemories, similarMemories, importantMemories] = await Promise.all([
    retrieveByRecency(agentId, candidateLimit),
    retrieveBySimilarity(agentId, query, candidateLimit),
    retrieveByImportance(agentId, candidateLimit),
  ]);

  // 2. Merge and score
  const memoryScores = new Map<string, { memory: Memory; score: number }>();

  const addWithScore = (memories: Memory[], getScore: (m: Memory, idx: number) => number) => {
    memories.forEach((m, idx) => {
      const existing = memoryScores.get(m.id);
      const score = getScore(m, idx);
      if (existing) {
        existing.score += score;
      } else {
        memoryScores.set(m.id, { memory: m, score });
      }
    });
  };

  // Score by recency (higher rank = higher score)
  addWithScore(recentMemories, (_, idx) => config.recencyWeight * (1 - idx / candidateLimit));

  // Score by similarity
  addWithScore(similarMemories, (m) => config.similarityWeight * (m as any).similarity);

  // Score by importance
  addWithScore(importantMemories, (m) => config.importanceWeight * m.metadata.importance);

  // 3. Sort by score and return top N
  return Array.from(memoryScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.memory);
}
```

---

## Context Building

### Token Budget Management

```typescript
interface ContextBudget {
  total: number; // Total tokens available
  system: number; // Reserved for system prompt
  tools: number; // Reserved for tool schemas
  memory: number; // Available for memory
  output: number; // Reserved for output
}

class ContextBuilder {
  async buildContext(
    agent: Agent,
    currentInput: string
  ): Promise<{ messages: Message[]; tokenCount: number }> {
    const budget = this.calculateBudget(agent);

    // 1. Always include system prompt
    const messages: Message[] = [
      {
        role: 'system',
        content: agent.instructions,
      },
    ];

    let usedTokens = this.countTokens(agent.instructions);

    // 2. Reserve space for current input + expected output
    const inputTokens = this.countTokens(currentInput);
    const reservedForOutput = budget.output;
    const availableForMemory = budget.total - usedTokens - inputTokens - reservedForOutput;

    // 3. Retrieve relevant memories
    const memories = await this.memoryManager.retrieveHybrid(
      agent.id,
      currentInput,
      100 // Get many candidates
    );

    // 4. Fit memories into budget
    for (const memory of memories) {
      const memoryTokens = this.countTokens(memory.content);

      if (usedTokens + memoryTokens > availableForMemory) {
        // Try to summarize remaining memories
        const remainingMemories = memories.slice(memories.indexOf(memory));
        if (remainingMemories.length > 0) {
          const summary = await this.summarize(remainingMemories);
          const summaryTokens = this.countTokens(summary);

          if (usedTokens + summaryTokens <= availableForMemory) {
            messages.push({
              role: 'system',
              content: `[Previous context summary]: ${summary}`,
            });
            usedTokens += summaryTokens;
          }
        }
        break;
      }

      messages.push(this.memoryToMessage(memory));
      usedTokens += memoryTokens;
    }

    // 5. Add current input
    messages.push({ role: 'user', content: currentInput });

    return { messages, tokenCount: usedTokens + inputTokens };
  }

  private calculateBudget(agent: Agent): ContextBudget {
    const total = agent.contextWindow || 128_000;

    return {
      total,
      system: Math.min(4000, total * 0.05),
      tools: agent.tools.length * 500,
      output: Math.min(4000, total * 0.1),
      memory: total * 0.7,
    };
  }
}
```

---

## Automatic Summarization

When memory exceeds limits, automatic summarization compresses old context.

### Summarization Strategies

```typescript
type SummarizationStrategy =
  | 'simple' // Single LLM call to summarize
  | 'hierarchical' // Summarize in chunks, then summarize summaries
  | 'extractive' // Extract key points without generation
  | 'map-reduce'; // Summarize chunks in parallel, then combine

class Summarizer {
  async summarize(
    memories: Memory[],
    strategy: SummarizationStrategy = 'hierarchical',
    targetTokens: number = 2000
  ): Promise<string> {
    switch (strategy) {
      case 'simple':
        return this.simpleSummarize(memories, targetTokens);

      case 'hierarchical':
        return this.hierarchicalSummarize(memories, targetTokens);

      case 'extractive':
        return this.extractiveSummarize(memories, targetTokens);

      case 'map-reduce':
        return this.mapReduceSummarize(memories, targetTokens);
    }
  }

  private async hierarchicalSummarize(memories: Memory[], targetTokens: number): Promise<string> {
    const chunkSize = 10;
    const chunks = this.chunkArray(memories, chunkSize);

    // Level 1: Summarize each chunk
    const chunkSummaries = await Promise.all(chunks.map((chunk) => this.summarizeChunk(chunk)));

    // If still too large, summarize the summaries
    const totalTokens = this.countTokens(chunkSummaries.join('\n'));

    if (totalTokens > targetTokens && chunkSummaries.length > 1) {
      return this.hierarchicalSummarize(
        chunkSummaries.map((s) => ({ content: s }) as Memory),
        targetTokens
      );
    }

    return chunkSummaries.join('\n\n');
  }

  private async summarizeChunk(memories: Memory[]): Promise<string> {
    const content = memories.map((m) => m.content).join('\n---\n');

    const response = await this.llm.chat({
      model: 'gpt-4o-mini', // Use fast, cheap model for summarization
      messages: [
        {
          role: 'system',
          content: `Summarize the following conversation/context concisely.
                    Focus on: key decisions, facts learned, user preferences.
                    Be brief but preserve important details.`,
        },
        { role: 'user', content },
      ],
      maxTokens: 500,
    });

    return response.content;
  }
}
```

### Importance Scoring

Automatically score memory importance for better retrieval.

```typescript
class ImportanceScorer {
  async scoreMemory(memory: Memory): Promise<number> {
    let score = 0.5; // Base score

    // 1. Content-based signals
    const content = memory.content.toLowerCase();

    // User preferences and facts
    if (
      content.includes('my name is') ||
      content.includes('i prefer') ||
      content.includes('remember that')
    ) {
      score += 0.3;
    }

    // Decisions and commitments
    if (content.includes('i will') || content.includes("let's do") || content.includes('decided')) {
      score += 0.2;
    }

    // Tool results (usually important)
    if (memory.type === 'tool_result') {
      score += 0.1;
    }

    // 2. Recency decay
    const hoursAgo = (Date.now() - memory.timestamp.getTime()) / (1000 * 60 * 60);
    const recencyBonus = Math.max(0, 0.2 - (hoursAgo / 24) * 0.1);
    score += recencyBonus;

    // 3. Access frequency (memories accessed more often are likely important)
    const accessBonus = Math.min(0.1, memory.accessCount * 0.02);
    score += accessBonus;

    return Math.min(1, Math.max(0, score));
  }
}
```

---

## Memory Persistence

### Backup and Restore

```typescript
class MemoryBackup {
  async backup(agentId: string): Promise<BackupFile> {
    const [episodic, semantic] = await Promise.all([
      this.exportEpisodicMemories(agentId),
      this.exportSemanticMemories(agentId),
    ]);

    return {
      version: '1.0',
      agentId,
      exportedAt: new Date(),
      episodic,
      semantic,
    };
  }

  async restore(backup: BackupFile, targetAgentId?: string): Promise<void> {
    const agentId = targetAgentId || backup.agentId;

    // Clear existing memories
    await this.clearMemories(agentId);

    // Restore episodic
    await this.importEpisodicMemories(agentId, backup.episodic);

    // Restore semantic (re-generate embeddings if model changed)
    await this.importSemanticMemories(agentId, backup.semantic);
  }
}
```

### Memory Sharing Between Agents

```typescript
interface SharedMemoryPool {
  // Create a shared knowledge base
  createPool(name: string, agentIds: string[]): Promise<string>;

  // Add memory to shared pool
  contribute(poolId: string, memory: Memory): Promise<void>;

  // Query shared pool
  query(poolId: string, query: string): Promise<Memory[]>;

  // Sync pool to agent's semantic memory
  syncToAgent(poolId: string, agentId: string): Promise<void>;
}

// Use case: Multiple agents share domain knowledge
const technicalKnowledge = await memoryPool.createPool('technical-docs', [
  'researcher-agent',
  'coder-agent',
  'reviewer-agent',
]);

// Researcher finds and stores knowledge
await memoryPool.contribute(technicalKnowledge, {
  content: 'WebGPU requires WGSL shaders, not GLSL',
  type: 'fact',
  source: 'MDN documentation',
});

// Coder can now access this knowledge
const relevantFacts = await memoryPool.query(technicalKnowledge, 'how do shaders work in WebGPU?');
```

---

## Configuration

```typescript
interface MemoryConfig {
  // Storage backends
  redis: {
    url: string;
    prefix: string;
    ttl: number; // Default TTL for L2 memories
  };

  postgres: {
    connectionString: string;
    poolSize: number;
  };

  // Embedding model
  embeddings: {
    provider: 'openai' | 'local' | 'cohere';
    model: string; // 'text-embedding-3-small' or local model name
    dimensions: number; // 1536 for OpenAI, 384 for local
    batchSize: number; // Batch embedding requests
  };

  // Retrieval settings
  retrieval: {
    defaultLimit: number;
    maxLimit: number;
    strategy: 'recency' | 'semantic' | 'importance' | 'hybrid';
    hybridWeights: {
      recency: number;
      similarity: number;
      importance: number;
    };
  };

  // Summarization
  summarization: {
    enabled: boolean;
    threshold: number; // Token count to trigger
    strategy: SummarizationStrategy;
    model: string; // Model to use for summarization
  };

  // Maintenance
  maintenance: {
    cleanupInterval: string; // Cron expression
    retentionDays: number; // How long to keep old memories
    compactionEnabled: boolean;
  };
}

// Default configuration
const defaultConfig: MemoryConfig = {
  redis: {
    url: 'redis://localhost:6379',
    prefix: 'cogitator',
    ttl: 86400, // 24 hours
  },
  postgres: {
    connectionString: 'postgres://localhost/cogitator',
    poolSize: 10,
  },
  embeddings: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    batchSize: 100,
  },
  retrieval: {
    defaultLimit: 20,
    maxLimit: 100,
    strategy: 'hybrid',
    hybridWeights: {
      recency: 0.3,
      similarity: 0.5,
      importance: 0.2,
    },
  },
  summarization: {
    enabled: true,
    threshold: 50_000,
    strategy: 'hierarchical',
    model: 'gpt-4o-mini',
  },
  maintenance: {
    cleanupInterval: '0 3 * * *', // 3 AM daily
    retentionDays: 90,
    compactionEnabled: true,
  },
};
```

---

## Performance Optimizations

### 1. Embedding Cache

```typescript
class EmbeddingCache {
  private cache: LRUCache<string, number[]>;

  constructor() {
    this.cache = new LRUCache({
      max: 10_000,
      ttl: 1000 * 60 * 60 * 24, // 24 hours
    });
  }

  async getOrCompute(text: string): Promise<number[]> {
    const hash = this.hashText(text);
    let embedding = this.cache.get(hash);

    if (!embedding) {
      embedding = await this.embedder.embed(text);
      this.cache.set(hash, embedding);
    }

    return embedding;
  }
}
```

### 2. Batch Operations

```typescript
class BatchMemoryWriter {
  private buffer: Memory[] = [];
  private flushInterval: NodeJS.Timer;

  constructor(
    private batchSize = 100,
    private flushMs = 1000
  ) {
    this.flushInterval = setInterval(() => this.flush(), flushMs);
  }

  add(memory: Memory): void {
    this.buffer.push(memory);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.batchSize);
    await this.db.batchInsert('episodic_memories', batch);
  }
}
```

### 3. Index Optimization

```sql
-- Partial indexes for common queries
CREATE INDEX idx_recent_important ON episodic_memories (agent_id, created_at DESC)
  WHERE importance > 0.7;

-- Covering index to avoid table lookups
CREATE INDEX idx_episodic_cover ON episodic_memories (agent_id, created_at DESC)
  INCLUDE (content, type, importance);

-- BRIN index for time-series data (efficient for large tables)
CREATE INDEX idx_created_brin ON episodic_memories USING brin (created_at);
```

---

## Monitoring

### Key Metrics

```typescript
const memoryMetrics = {
  // Storage
  'memory.episodic.count': Gauge,
  'memory.semantic.count': Gauge,
  'memory.storage.bytes': Gauge,

  // Operations
  'memory.store.duration': Histogram,
  'memory.retrieve.duration': Histogram,
  'memory.retrieve.hit_rate': Gauge,

  // Summarization
  'memory.summarization.runs': Counter,
  'memory.summarization.tokens_saved': Counter,

  // Health
  'memory.redis.connected': Gauge,
  'memory.postgres.pool.active': Gauge,
};
```
