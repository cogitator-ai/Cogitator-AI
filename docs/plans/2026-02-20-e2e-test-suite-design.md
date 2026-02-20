# E2E Test Suite Design

## Goal

Comprehensive, strict e2e test coverage across all Cogitator packages. Tests exercise real LLM backends (Ollama in CI, Google Gemini as judge on main). When something breaks, tests fail — no silent skips.

## Decisions

- **Scope:** our code + LLM output quality validation
- **Flakiness strategy:** structured outputs where possible, soft assertions for natural language, LLM-as-judge for quality
- **A2A testing:** full HTTP loop (real server + client)
- **Location:** separate `packages/e2e/` package
- **Judge model:** Gemini 2.5 Flash (free tier, fast, different model than test subject)

## Architecture

### Three-Tier Assertions

1. **Hard assertions** — structural: `typeof output === 'string'`, `usage.totalTokens > 0`, `toolCalls.length > 0`
2. **Structured output validation** — parse JSON, validate schema fields and types
3. **LLM Judge** — Gemini Flash evaluates answer quality against criteria, returns `{pass: true/false}`

### Package Structure

```
packages/e2e/
  package.json                        # @cogitator-ai/e2e
  vitest.config.ts                    # 60s timeout, sequential execution
  src/
    helpers/
      judge.ts                        # LLMJudge class wrapping Gemini Flash
      setup.ts                        # shared Cogitator/backend/agent factories
      assertions.ts                   # expectLLMJudge(), expectToolCalled()
    __tests__/
      core/
        agent-simple-chat.e2e.ts      # basic Q&A, answer quality
        agent-tool-execution.e2e.ts   # tool calling + result handling
        agent-multi-turn.e2e.ts       # conversation memory across turns
        agent-structured-output.e2e.ts # JSON schema responses
        streaming.e2e.ts              # chunk delivery, usage stats
        error-handling.e2e.ts         # bad model, timeout, invalid tools
      a2a/
        server-client-flow.e2e.ts     # full HTTP: send -> get -> artifacts
        streaming-sse.e2e.ts          # SSE event delivery
        agent-card-discovery.e2e.ts   # /.well-known/agent.json
        task-lifecycle.e2e.ts         # create -> working -> completed
      cross-package/
        cogitator-via-a2a.e2e.ts      # Agent running behind A2A server
        remote-tool-execution.e2e.ts  # A2A client as tool for another agent
```

### LLM Judge

```typescript
class LLMJudge {
  constructor(backend: GoogleBackend, model: string);

  async evaluate(opts: {
    question: string;
    answer: string;
    criteria: string;
  }): Promise<{ pass: boolean; reason?: string }>;
}
```

Judge sends a structured prompt to Gemini Flash asking for `{"pass": true/false}` response. On PRs without `GOOGLE_API_KEY`, judge assertions skip gracefully (test still runs hard assertions).

### Helper: `expectLLMJudge()`

```typescript
async function expectLLMJudge(
  output: string,
  opts: { question: string; criteria: string }
): Promise<void>;
```

Wraps judge call + expect. Skips if no Gemini key available (logs warning, doesn't fail).

### Shared Setup

```typescript
// setup.ts
function createTestCogitator(): Cogitator; // Ollama backend, qwen2.5:0.5b
function createTestAgent(opts?): Agent; // simple agent with optional tools
function createTestJudge(): LLMJudge | null; // Gemini judge or null if no key
function createTestTools(): Record<string, Tool>; // calculator, echo, failing tool
```

## Test Scenarios

### Core: agent-simple-chat.e2e.ts

| Test                        | Hard Assertions              | Judge                          |
| --------------------------- | ---------------------------- | ------------------------------ |
| answers factual questions   | output is string, tokens > 0 | "Answer correctly names Tokyo" |
| follows system instructions | output is string             | "Response is exactly 3 words"  |
| handles minimal input       | no crash, output is string   | —                              |

### Core: agent-tool-execution.e2e.ts

| Test                              | Hard Assertions                         | Judge                 |
| --------------------------------- | --------------------------------------- | --------------------- |
| calls single tool and uses result | toolCalls.length > 0, tool name correct | "Answer contains 105" |
| calls multiple tools in sequence  | toolCalls.length >= 2                   | "Answer contains 17"  |
| handles tool that throws          | no crash, output is string              | "Acknowledges error"  |
| respects maxIterations            | tool call rounds <= limit               | —                     |

### Core: agent-multi-turn.e2e.ts

| Test                                | Hard Assertions          | Judge                           |
| ----------------------------------- | ------------------------ | ------------------------------- |
| remembers context across turns      | both outputs are strings | "Second response mentions Alex" |
| maintains tool results across turns | both have tokens > 0     | "Response contains 75"          |

### Core: agent-structured-output.e2e.ts

| Test                               | Hard Assertions                              | Judge |
| ---------------------------------- | -------------------------------------------- | ----- |
| returns valid JSON matching schema | JSON.parse succeeds, fields correct types    | —     |
| returns valid JSON array           | array.length === 3, each has required fields | —     |

### Core: streaming.e2e.ts

| Test                          | Hard Assertions                           | Judge |
| ----------------------------- | ----------------------------------------- | ----- |
| delivers chunks incrementally | chunks.length > 1, each has delta.content | —     |
| streams with tool calls       | stream contains tool call chunks          | —     |
| reports usage in final chunk  | last chunk has usage.inputTokens > 0      | —     |

### Core: error-handling.e2e.ts

| Test                          | Hard Assertions           | Judge |
| ----------------------------- | ------------------------- | ----- |
| throws on invalid model       | throws LLMError           | —     |
| throws on unreachable backend | throws LLM_UNAVAILABLE    | —     |
| handles malformed tool schema | throws or error, no crash | —     |

### A2A: server-client-flow.e2e.ts

| Test                                      | Hard Assertions                                      | Judge                |
| ----------------------------------------- | ---------------------------------------------------- | -------------------- |
| sends message and receives completed task | task.status.state === 'completed', artifacts present | "Answer contains 4"  |
| sends message with tool-equipped agent    | task completed                                       | "Answer contains 42" |
| returns error for empty message           | JSON-RPC error code -32602                           | —                    |
| handles concurrent requests               | all 3 tasks completed, unique IDs                    | —                    |

### A2A: streaming-sse.e2e.ts

| Test                           | Hard Assertions                           | Judge               |
| ------------------------------ | ----------------------------------------- | ------------------- |
| streams status updates via SSE | first=working, last=completed             | —                   |
| streams artifacts via SSE      | artifact-update events received           | "Contains counting" |
| handles client disconnect      | no server crash, subsequent requests work | —                   |

### A2A: agent-card-discovery.e2e.ts

| Test                                | Hard Assertions              | Judge |
| ----------------------------------- | ---------------------------- | ----- |
| serves card at well-known URL       | status 200, valid card shape | —     |
| card reflects agent tools as skills | skills.length matches tools  | —     |
| client caches agent card            | no duplicate HTTP requests   | —     |

### A2A: task-lifecycle.e2e.ts

| Test                            | Hard Assertions          | Judge |
| ------------------------------- | ------------------------ | ----- |
| task retrievable by ID          | same task returned       | —     |
| task has correct timestamps     | valid ISO string, recent | —     |
| cancel error for completed task | error response           | —     |
| error for unknown task ID       | error code -32001        | —     |

### Cross-Package: cogitator-via-a2a.e2e.ts

| Test                              | Hard Assertions                                    | Judge                |
| --------------------------------- | -------------------------------------------------- | -------------------- |
| executes through full A2A stack   | task completed, artifacts                          | "Answer contains 96" |
| streams through A2A               | working->completed events, artifact events         | —                    |
| agent card describes real agent   | name, skills match                                 | —                    |
| handles agent failure through A2A | task.status.state === 'failed', server still works | —                    |

### Cross-Package: remote-tool-execution.e2e.ts

| Test                                | Hard Assertions                | Judge                 |
| ----------------------------------- | ------------------------------ | --------------------- |
| agent uses remote A2A agent as tool | toolCalls includes remote tool | "Answer contains 105" |
| handles remote agent timeout        | throws within timeout          | —                     |
| handles remote agent unavailable    | tool returns error             | —                     |

## CI Integration

### Integration Tests Workflow (`.github/workflows/integration.yml`)

**Ollama job** (PR + main):

- Pulls `qwen2.5:0.5b`
- Runs `packages/e2e/` tests
- Judge assertions skip (no Gemini key)
- Hard assertions must all pass

**Google Judge job** (main only):

- Same e2e tests
- `GOOGLE_API_KEY` from secrets
- Judge assertions run
- Both hard + judge must pass

### Test Execution

- `fileParallelism: false` — sequential to avoid overloading Ollama
- `testTimeout: 60_000` — LLM calls can be slow
- `NODE_OPTIONS: --max-old-space-size=4096`

## Coverage Status

### Phase 1 — Done

| Package              | Tests  | What's covered                                                                                |
| -------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `@cogitator-ai/core` | 17     | Agent chat, tool execution, multi-turn (memory), structured output, streaming, error handling |
| `@cogitator-ai/a2a`  | 14     | Server/client flow, SSE streaming, agent card discovery, task lifecycle                       |
| Cross-package        | 6      | Cogitator-via-A2A full stack, remote tool execution via `asTool()`                            |
| **Total**            | **37** |                                                                                               |

### Phase 2 — Done

| Package                               | Tests  | What's covered                                                                    |
| ------------------------------------- | ------ | --------------------------------------------------------------------------------- |
| `@cogitator-ai/memory`                | 9      | InMemoryAdapter CRUD, context builder, agent memory integration, thread isolation |
| `@cogitator-ai/core` (multi-provider) | 7      | parseModel routing, backend creation, Google Gemini chat/streaming/tools          |
| `@cogitator-ai/workflows`             | 9      | DAG execution (sequential, conditional, parallel, loop), agent nodes, checkpoint  |
| `@cogitator-ai/swarms`                | 4      | Round-robin, pipeline strategies, error handling, event emission                  |
| `@cogitator-ai/mcp`                   | 4      | Tool adapter (cogitatorToMCP, mcpToCogitator, zodToJsonSchema, round-trip)        |
| **Total**                             | **33** |                                                                                   |

### Phase 3 — Not started

| Package                 | Priority | What to test                                                |
| ----------------------- | -------- | ----------------------------------------------------------- |
| `@cogitator-ai/sandbox` | Medium   | Docker sandbox execution, WASM sandbox, timeout/limits      |
| `@cogitator-ai/worker`  | Low      | BullMQ job queue, distributed agent execution               |
| `@cogitator-ai/types`   | Low      | Zod schema serialization/deserialization, config validation |

## Totals (Phase 1 + Phase 2)

- **20 test files** (12 Phase 1 + 8 Phase 2)
- **70 test cases** (37 Phase 1 + 33 Phase 2)
- **7 packages covered** (core, a2a, cross-package, memory, workflows, multi-provider, mcp, swarms)
- **3 assertion tiers** (hard, structured, judge)
- **2 CI modes** (PR: hard only, main: hard + judge)
