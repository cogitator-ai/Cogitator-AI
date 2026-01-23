# Cogitator Roadmap

## 🎯 Priority Levels

- 🔴 **Critical** — Bugs, security issues, broken features
- 🟠 **High Impact** — Killer features that differentiate the product
- 🟡 **Medium** — Quality of life improvements
- 🟢 **Nice to Have** — Polish and extras

---

### ~~3. Hybrid Search (BM25 + Vector)~~ ✅ COMPLETED

**Package:** `packages/memory`

**Status:** Implemented in `packages/memory/src/search/`

**Features:**

- `BM25Index` — Pure JS Okapi BM25 with inverted index
- `HybridSearch` — Combines vector + keyword search with RRF
- `PostgresAdapter` — tsvector full-text search with GIN index
- `InMemoryEmbeddingAdapter` — In-memory vector + BM25 for testing

**Usage:**

```typescript
import { HybridSearch, InMemoryEmbeddingAdapter } from '@cogitator-ai/memory';

const search = new HybridSearch({
  embeddingAdapter,
  embeddingService,
  defaultWeights: { bm25: 0.4, vector: 0.6 },
});

const results = await search.search({
  query: 'authentication flow',
  strategy: 'hybrid',
  limit: 10,
});
```

---

### 4. Real-time Streaming for Workflows

**Package:** `packages/workflows`

**What:** Server-Sent Events for live DAG execution progress.

**API Design:**

```typescript
// packages/workflows/src/executor-stream.ts
const stream = workflow.executeStream(input);

for await (const event of stream) {
  switch (event.type) {
    case 'workflow_started':
      console.log(`Started: ${event.workflowId}`);
      break;
    case 'node_started':
      console.log(`Node ${event.nodeName} started`);
      break;
    case 'node_progress':
      console.log(`Progress: ${event.progress}%`);
      break;
    case 'node_completed':
      console.log(`Node ${event.nodeName} completed`, event.output);
      break;
    case 'workflow_completed':
      console.log(`Done!`, event.result);
      break;
  }
}
```

**Why:** Enables live progress visualization, better UX for long-running workflows.

---

### 5. Neuro-Symbolic Agent Tools

**Package:** `packages/neuro-symbolic` + `packages/core`

**What:** Expose neuro-symbolic capabilities as tools that agents can use.

**API Design:**

```typescript
import { createNeuroSymbolicTools } from '@cogitator-ai/neuro-symbolic';

const nsTools = createNeuroSymbolicTools({
  logicKB: knowledgeBase,
  graphAdapter: postgresGraph,
  z3Available: true,
});

const agent = new Agent({
  name: 'reasoning-agent',
  tools: [
    nsTools.queryLogic, // Prolog-style queries
    nsTools.assertFact, // Add facts to KB
    nsTools.solveConstraints, // Z3 constraint solving
    nsTools.findPath, // Graph pathfinding
    nsTools.validatePlan, // Plan verification
  ],
});
```

**Why:** Combines LLM reasoning with formal logic for more reliable answers.

---

## 🟡 Medium Priority

### 6. Tool Caching Layer

**Package:** `packages/core`

**What:** Semantic cache for tool results to avoid redundant API calls.

**API Design:**

```typescript
import { tool, withCache } from '@cogitator-ai/core';

const webSearch = tool({
  name: 'webSearch',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    /* ... */
  },
});

const cachedWebSearch = withCache(webSearch, {
  strategy: 'semantic', // Similar queries hit cache
  similarity: 0.95, // 95% similarity threshold
  ttl: '1h', // Cache for 1 hour
  maxSize: 1000, // Max cached entries
  storage: 'redis', // or 'memory'
});
```

**Implementation location:** `packages/core/src/cache/tool-cache.ts`

**Why:** Same query "weather in Paris" won't hit external API 100 times.

---

### 7. Prompt Injection Detection

**Package:** `packages/core/src/constitutional`

**What:** Detect jailbreak attempts and prompt injections in user input.

**API Design:**

```typescript
const filter = new InputFilter({
  detectInjection: true, // "Ignore previous instructions..."
  detectJailbreak: true, // DAN, roleplay attacks
  patterns: [/ignore.*previous.*instructions/i, /you are now/i, /pretend you are/i, /act as if/i],
  classifier: 'local', // Fast local classifier or LLM
  action: 'block', // 'block' | 'warn' | 'log'
});
```

**Why:** Constitutional AI filters output, but input also needs protection.

---

### 8. Cost Prediction Before Run

**Package:** `packages/core/src/cost-routing`

**What:** Estimate cost before running an agent.

**API Design:**

```typescript
const estimate = await cogitator.estimateCost({
  agent,
  input: "Analyze this complex document and summarize key points",
  options: {
    assumeToolCalls: 3,      // Expected tool calls
    assumeIterations: 2,     // Expected LLM rounds
  }
})

// Returns:
{
  minCost: 0.15,
  maxCost: 0.45,
  expectedCost: 0.28,
  confidence: 0.8,
  breakdown: {
    inputTokens: { min: 1000, max: 2000 },
    outputTokens: { min: 500, max: 1500 },
    model: 'gpt-4o',
    pricePerMInputTokens: 2.50,
    pricePerMOutputTokens: 10.00
  }
}
```

**Why:** Users see "This will cost ~$0.30" before running expensive tasks.

---

### 9. Agent Persistence/Serialization

**Package:** `packages/core`

**What:** Save and load agent state for long-running tasks.

**API Design:**

```typescript
// Serialize agent with full state
const snapshot = agent.serialize();
// {
//   config: { model, instructions, tools: [...toolNames] },
//   state: { ... },
//   version: '1.0.0'
// }

// Save to file/database
await fs.writeFile('agent-snapshot.json', JSON.stringify(snapshot));

// Later: restore agent
const restored = Agent.deserialize(snapshot, { toolRegistry });
```

**Why:** Pause/resume agents across process restarts, share agent configurations.

---

### 10. MCP Resource Publishing

**Package:** `packages/mcp/src/server`

**What:** MCPServer can currently only expose tools, not resources or prompts.

**API Design:**

```typescript
const server = new MCPServer({ name: 'cogitator', version: '1.0.0' });

// Register resources (NEW)
server.registerResource({
  uri: 'memory://threads',
  name: 'Conversation Threads',
  mimeType: 'application/json',
  read: async () => getAllThreads(),
});

server.registerResource({
  uri: 'memory://thread/{id}',
  name: 'Thread Content',
  read: async ({ id }) => getThreadContent(id),
});

// Register prompts (NEW)
server.registerPrompt({
  name: 'summarize',
  description: 'Summarize content',
  arguments: [{ name: 'content', required: true }],
  get: async ({ content }) => ({
    messages: [{ role: 'user', content: `Summarize: ${content}` }],
  }),
});
```

**Why:** Full MCP spec compliance for better Claude Desktop integration.

---

### 11. WASM Tool Hot-Reload

**Package:** `packages/wasm-tools`

**What:** Update WASM modules without restarting the process.

**API Design:**

```typescript
import { WasmToolManager } from '@cogitator-ai/wasm-tools';

const manager = new WasmToolManager();

// Watch for changes
manager.watch('./plugins/*.wasm', {
  onLoad: (name) => console.log(`Loaded: ${name}`),
  onReload: (name) => console.log(`Reloaded: ${name}`),
  onError: (name, err) => console.error(`Failed: ${name}`, err),
});

// Tools auto-update when .wasm files change
const tools = manager.getTools();
```

**Why:** Better developer experience — change tool, immediately works.

---

### 12. Distributed Swarm Execution

**Package:** `packages/swarms` + `packages/worker`

**What:** Swarm agents run on different workers via job queue.

**API Design:**

```typescript
const swarm = new Swarm({
  strategy: 'hierarchical',
  agents: [supervisor, ...workers],
  distributed: {
    enabled: true,
    queue: 'swarm-jobs',
    workerConcurrency: 4,
    timeout: 300000,
  },
});

// Execution distributes across workers
const result = await swarm.run({
  input: 'Complex multi-agent task',
  // Each agent runs as separate job
});
```

**Why:** Horizontal scaling for heavy swarm workloads.

---

## 🟢 Nice to Have

### 13. Agent Marketplace / Discovery

**Package:** New `packages/marketplace`

**What:** Registry of pre-built agents with versioning and sharing.

**API Design:**

```typescript
import { Marketplace } from '@cogitator-ai/marketplace';

const marketplace = new Marketplace({
  registry: 'https://registry.cogitator.ai', // or self-hosted
});

// Discover agents
const agents = await marketplace.search({
  tags: ['code', 'review'],
  minRating: 4.0,
});

// Install agent
const codeReviewer = await marketplace.get('code-reviewer@1.2.0');

// Publish your agent
await marketplace.publish(myAgent, {
  name: 'my-assistant',
  version: '1.0.0',
  tags: ['productivity'],
  readme: '# My Assistant\n...',
  license: 'MIT',
});
```

**Why:** Community sharing, like npm for AI agents.

---

### 14. Multi-Modal Tool Support

**Package:** `packages/core/src/tools`

**What:** Tools that accept/return images, audio, video.

**API Design:**

```typescript
const imageAnalyzer = tool({
  name: 'analyzeImage',
  parameters: z.object({
    image: z.union([
      z.string().url(), // URL
      z.instanceof(Buffer), // Binary
      z.object({
        // Base64
        data: z.string(),
        mimeType: z.string(),
      }),
    ]),
    prompt: z.string().optional(),
  }),
  execute: async ({ image, prompt }) => {
    // Send to vision model
    return await visionModel.analyze(image, prompt);
  },
});

const audioTranscriber = tool({
  name: 'transcribe',
  parameters: z.object({
    audio: z.instanceof(Buffer),
    language: z.string().optional(),
  }),
  returns: z.object({
    text: z.string(),
    segments: z.array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      })
    ),
  }),
  execute: async ({ audio, language }) => {
    return await whisper.transcribe(audio, { language });
  },
});
```

**Why:** GPT-4V, Claude 3 support vision — tools should too.

---

### 15. More WASM Pre-built Tools

**Package:** `packages/wasm-tools`

**What:** Expand the library of fast WASM tools.

**New tools to add:**

- `regex` — Pattern matching and replacement
- `datetime` — Date parsing, formatting, timezone conversion
- `compression` — gzip, brotli, zstd
- `crypto-sign` — Ed25519, ECDSA signing/verification
- `markdown` — Markdown to HTML conversion
- `csv` — CSV parsing and generation
- `xml` — XML parsing (via quick-xml WASM)
- `diff` — Text diff generation
- `slug` — URL-safe slug generation
- `validation` — Email, URL, UUID validation

**Why:** 100-500x faster than Docker, ~20x lower memory.

---

### 16. Workflow Checkpoint Granularity

**Package:** `packages/workflows`

**What:** Per-node checkpoints instead of per-iteration.

**Current:** Checkpoint saved after ALL parallel nodes complete.
**Needed:** Checkpoint after EACH node completes.

```typescript
const executor = new WorkflowExecutor({
  checkpointStrategy: 'per-node', // NEW: saves after each node
  // vs 'per-iteration' (current default)
});
```

**Why:** Can resume from partial parallel execution after crash.

---

### 17. Knowledge Graph Adapter Implementation

**Package:** `packages/neuro-symbolic`

**What:** Currently only interface exists, no actual GraphAdapter.

**Need to implement:**

```typescript
// packages/neuro-symbolic/src/knowledge-graph/adapters/
├── postgres-graph-adapter.ts  // Using pg + ltree extension
├── neo4j-graph-adapter.ts     // Native graph DB
├── memory-graph-adapter.ts    // For testing
```

**Why:** Neuro-symbolic graph features don't work without adapter.

---

## Implementation Order Recommendation

### Phase 1: Stability

1. ~~Docker timeout fix~~ ✅
2. ~~Swarm strategy tests~~ ✅
3. ~~Workflow parallel edge fix~~ ✅

### Phase 2: Core Features

4. ~~Agent-as-Tool composition~~ ✅
5. Semantic memory consolidation (#2)
6. ~~Hybrid search (#3)~~ ✅
7. Neuro-symbolic tools integration (#5)

### Phase 3: DX & Polish

8. Real-time workflow streaming (#4)
9. Tool caching (#6)
10. Cost prediction (#8)
11. Agent serialization (#9)

### Phase 4: Ecosystem

12. MCP resource publishing (#10)
13. WASM hot-reload (#11)
14. Distributed swarms (#12)
15. Marketplace (#13)
16. Multi-modal tools (#14)

---

_Last updated: 2026-01-23_
