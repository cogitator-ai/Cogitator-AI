# A2A Protocol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement Google's A2A Protocol v0.3 as `@cogitator-ai/a2a` — the first TypeScript agent runtime with native A2A support.

**Architecture:** New monolith package `packages/a2a` with A2A types, JSON-RPC layer, server (Agent Card + Task management), client (discovery + `asTool()` bridge), and thin framework adapters. Zero external deps beyond workspace packages and framework peer deps. Mirrors `@cogitator-ai/mcp` package patterns.

**Tech Stack:** TypeScript strict ESM, Zod v4, native `fetch` for client HTTP, `node:crypto` for IDs, SSE via raw text/event-stream responses.

**Design doc:** `docs/plans/2026-02-19-a2a-protocol-design.md`

---

## Task 1: Package Scaffold

**Files:**

- Create: `packages/a2a/package.json`
- Create: `packages/a2a/tsconfig.json`
- Create: `packages/a2a/vitest.config.ts`
- Create: `packages/a2a/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@cogitator-ai/a2a",
  "version": "0.1.0",
  "description": "A2A (Agent-to-Agent) Protocol v0.3 implementation for Cogitator",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./express": {
      "types": "./dist/adapters/express.d.ts",
      "import": "./dist/adapters/express.js"
    },
    "./hono": {
      "types": "./dist/adapters/hono.d.ts",
      "import": "./dist/adapters/hono.js"
    },
    "./fastify": {
      "types": "./dist/adapters/fastify.d.ts",
      "import": "./dist/adapters/fastify.js"
    },
    "./koa": {
      "types": "./dist/adapters/koa.d.ts",
      "import": "./dist/adapters/koa.js"
    },
    "./next": {
      "types": "./dist/adapters/next.d.ts",
      "import": "./dist/adapters/next.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@cogitator-ai/types": "workspace:*",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  },
  "peerDependencies": {
    "@cogitator-ai/core": "workspace:*",
    "express": ">=4.18.0",
    "hono": ">=4.0.0",
    "fastify": ">=4.0.0",
    "koa": ">=2.0.0",
    "next": ">=14.0.0"
  },
  "peerDependenciesMeta": {
    "@cogitator-ai/core": { "optional": true },
    "express": { "optional": true },
    "hono": { "optional": true },
    "fastify": { "optional": true },
    "koa": { "optional": true },
    "next": { "optional": true }
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://npm.pkg.github.com"
  },
  "license": "MIT"
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/__tests__"]
}
```

**Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
    testTimeout: 30000,
  },
});
```

**Step 4: Create empty src/index.ts**

```ts
export {};
```

**Step 5: Install deps and verify build**

Run: `cd /Users/mac/Projects/Cogitator && pnpm install && pnpm --filter @cogitator-ai/a2a build`
Expected: Successful build with empty dist/index.js

**Step 6: Commit**

```bash
git add packages/a2a/
git commit -m "feat(a2a): scaffold @cogitator-ai/a2a package

Empty package with subpath exports for framework adapters.
Follows same patterns as @cogitator-ai/mcp."
```

---

## Task 2: A2A Types

**Files:**

- Create: `packages/a2a/src/types.ts`
- Modify: `packages/a2a/src/index.ts`

**Step 1: Write the types test**

Create: `packages/a2a/src/__tests__/types.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type {
  AgentCard,
  A2ATask,
  A2AMessage,
  TextPart,
  FilePart,
  DataPart,
  TaskState,
  TaskStatus,
  A2ACapabilities,
  AgentSkill,
  AgentProvider,
  A2AError,
} from '../types';

describe('A2A types', () => {
  it('should construct a valid AgentCard', () => {
    const card: AgentCard = {
      name: 'test-agent',
      url: 'https://example.com/a2a',
      version: '0.3',
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        {
          id: 'search',
          name: 'Web Search',
          description: 'Search the web',
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    };
    expect(card.name).toBe('test-agent');
    expect(card.capabilities.streaming).toBe(true);
  });

  it('should construct a valid A2ATask', () => {
    const task: A2ATask = {
      id: 'task_123',
      contextId: 'ctx_456',
      status: { state: 'completed', timestamp: new Date().toISOString() },
      history: [],
      artifacts: [],
    };
    expect(task.status.state).toBe('completed');
  });

  it('should construct messages with different part types', () => {
    const textMsg: A2AMessage = {
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    };

    const dataMsg: A2AMessage = {
      role: 'agent',
      parts: [{ type: 'data', mimeType: 'application/json', data: { key: 'value' } }],
    };

    const fileMsg: A2AMessage = {
      role: 'agent',
      parts: [{ type: 'file', uri: 'https://example.com/file.pdf', mimeType: 'application/pdf' }],
    };

    expect(textMsg.parts[0].type).toBe('text');
    expect(dataMsg.parts[0].type).toBe('data');
    expect(fileMsg.parts[0].type).toBe('file');
  });

  it('should validate all TaskState values', () => {
    const states: TaskState[] = [
      'working',
      'input-required',
      'completed',
      'failed',
      'canceled',
      'rejected',
    ];
    expect(states).toHaveLength(6);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogitator-ai/a2a test`
Expected: FAIL — types don't exist yet

**Step 3: Implement types.ts**

Create `packages/a2a/src/types.ts` with all A2A protocol types mapped from the spec:

- `TaskState` — union literal type: `'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected'`
- `TaskStatus` — `{ state, timestamp, message? }`
- `TextPart`, `FilePart`, `DataPart`, `Part` union
- `Artifact` — `{ id, parts, mimeType? }`
- `A2AMessage` — `{ role, parts, taskId?, contextId?, referenceTaskIds? }`
- `A2ATask` — `{ id, contextId, status, history, artifacts, metadata? }`
- `AgentCard` — full agent card with `name, description?, url, version, provider?, capabilities, skills, defaultInputModes, defaultOutputModes, securitySchemes?, security?`
- `AgentSkill` — `{ id, name, description?, inputModes, outputModes, examples? }`
- `AgentProvider` — `{ name, url?, contactEmail? }`
- `A2ACapabilities` — `{ streaming, pushNotifications, extendedAgentCard? }`
- `SendMessageConfiguration` — `{ acceptedOutputModes?, historyLength?, blocking?, timeout? }`
- `TaskFilter` — `{ contextId?, state?, limit?, offset? }`
- `TaskStore` interface — `{ create, get, update, list, delete }`
- `TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent` — SSE event types
- `A2AStreamEvent` — union of status/artifact update events
- `A2AError` — `{ code, message, data? }`
- `A2AServerConfig`, `A2AClientConfig` — constructor options

Keep terminal states as a const: `TERMINAL_STATES = ['completed', 'failed', 'canceled', 'rejected'] as const`

**Step 4: Update index.ts to export all types**

**Step 5: Run tests**

Run: `pnpm --filter @cogitator-ai/a2a test`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/a2a/
git commit -m "feat(a2a): add complete A2A protocol type definitions

All types from A2A spec v0.3: AgentCard, Task, Message, Part,
Artifact, TaskStore interface, stream events, error types."
```

---

## Task 3: JSON-RPC 2.0 Layer

**Files:**

- Create: `packages/a2a/src/json-rpc.ts`
- Create: `packages/a2a/src/__tests__/json-rpc.test.ts`

**Step 1: Write the test**

Test parsing valid/invalid JSON-RPC requests, creating success/error responses, validating method routing.

Key test cases:

- Parse valid request with method + params + id
- Reject missing jsonrpc field
- Reject missing method
- Create success response with result
- Create error response with code + message
- Parse batch requests (array of requests)

**Step 2: Run test to verify it fails**

**Step 3: Implement json-rpc.ts**

Functions to implement:

- `parseJsonRpcRequest(body: unknown): JsonRpcRequest | JsonRpcRequest[]` — validates structure, throws on invalid
- `createSuccessResponse(id, result): JsonRpcResponse`
- `createErrorResponse(id, error): JsonRpcResponse`
- `isValidRequest(req: unknown): req is JsonRpcRequest`
- Types: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcError`

This is a thin layer — no external deps, just validation and structure.

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git commit -m "feat(a2a): implement JSON-RPC 2.0 parser and serializer

Stateless functions for parsing requests, creating responses,
and validating JSON-RPC 2.0 message structure."
```

---

## Task 4: A2A Errors

**Files:**

- Create: `packages/a2a/src/errors.ts`
- Create: `packages/a2a/src/__tests__/errors.test.ts`

**Step 1: Write tests**

Test all A2A error factory functions create correct code/message/data.

**Step 2: Implement errors.ts**

A2A-specific error factories mapping to JSON-RPC error codes:

- `taskNotFound(taskId)` — code -32001
- `taskNotCancelable(taskId)` — code -32002
- `pushNotificationsNotSupported()` — code -32003
- `unsupportedOperation(method)` — code -32004
- `contentTypeNotSupported(type)` — code -32005
- `invalidAgentResponse(detail)` — code -32006
- Standard JSON-RPC errors: `parseError()`, `invalidRequest()`, `methodNotFound(method)`, `invalidParams(detail)`, `internalError(detail)`

Each returns `{ code, message, data? }` matching `A2AError`.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add A2A protocol error types and factories

JSON-RPC error codes for all A2A-specific error conditions
plus standard JSON-RPC errors (-32700 through -32603)."
```

---

## Task 5: Agent Card Generation

**Files:**

- Create: `packages/a2a/src/agent-card.ts`
- Create: `packages/a2a/src/__tests__/agent-card.test.ts`

**Step 1: Write tests**

Test cases:

- Generate card from Agent with name + description + tools → correct card structure
- Generate card from Agent with no tools → empty skills array
- Generate card from Agent with Zod-parameterized tools → skills have correct input schemas
- Card includes correct `version: '0.3'`
- Card reflects streaming capability
- Multiple agents → returns array of cards or card per agent

**Step 2: Implement agent-card.ts**

```ts
function generateAgentCard(agent: IAgent, options: AgentCardOptions): AgentCard;
```

Where `AgentCardOptions` = `{ url: string, capabilities?: Partial<A2ACapabilities>, provider?: AgentProvider }`.

Logic:

- `name` ← `agent.name`
- `description` ← `agent.config.description`
- `skills` ← map `agent.tools` through `toolToSkill(tool)` which extracts name, description, and converts Zod schema → JSON Schema for the skill's input description
- `version` ← `'0.3'`
- `capabilities` ← defaults `{ streaming: true, pushNotifications: false }`
- `defaultInputModes` ← `['text/plain']`
- `defaultOutputModes` ← `['text/plain', 'application/json']`

Uses `z.toJSONSchema()` from zod (same pattern as `toolToSchema` in core).

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): auto-generate Agent Card from Cogitator Agent

Maps Agent name, description, and tools to A2A Agent Card
with skills derived from Zod tool schemas."
```

---

## Task 6: TaskStore + InMemoryTaskStore

**Files:**

- Create: `packages/a2a/src/task-store.ts`
- Create: `packages/a2a/src/__tests__/task-store.test.ts`

**Step 1: Write tests**

Test InMemoryTaskStore:

- `create()` + `get()` round trip
- `update()` modifies state
- `get()` returns null for unknown ID
- `list()` with no filter returns all
- `list()` filters by contextId
- `list()` filters by state
- `delete()` removes task
- `delete()` on unknown ID is no-op

**Step 2: Implement task-store.ts**

`TaskStore` interface (from types.ts) + `InMemoryTaskStore` class backed by `Map<string, A2ATask>`.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add TaskStore interface and InMemoryTaskStore

Pluggable task storage for A2A task lifecycle. In-memory
implementation for dev/testing with filter support."
```

---

## Task 7: Task Manager

**Files:**

- Create: `packages/a2a/src/task-manager.ts`
- Create: `packages/a2a/src/__tests__/task-manager.test.ts`

**Step 1: Write tests**

Test TaskManager:

- `createTask(message)` → creates task with state=working, generates unique ID
- `completeTask(id, result)` → sets state=completed, adds artifacts from RunResult
- `failTask(id, error)` → sets state=failed, includes error details
- `cancelTask(id)` → sets state=canceled (only if non-terminal)
- `cancelTask(id)` on completed task → throws taskNotCancelable
- `getTask(id)` → returns task or throws taskNotFound
- Running task emits status updates (EventEmitter pattern for SSE)

**Step 2: Implement task-manager.ts**

`TaskManager` class:

- Constructor takes `TaskStore` and `Cogitator`
- `createTask(agentName, message, config?)` → generates task ID, stores initial task, returns it
- `executeTask(task, agent, message)` → calls `cogitator.run()`, maps RunResult to task completion
- `completeTask(taskId, result)` → updates store, emits event
- `failTask(taskId, error)` → updates store, emits event
- `cancelTask(taskId)` → validates state, updates store, emits event
- `getTask(taskId)` → delegates to store
- Extends `EventEmitter` or uses custom typed event bus for SSE streaming
- Maps `RunResult.output` → `TextPart` in task history
- Maps `RunResult.structured` → `DataPart` as artifact
- Maps `RunResult.toolCalls` → metadata on task

Active tasks tracked via `Map<string, AbortController>` for cancellation support.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add TaskManager for task lifecycle orchestration

Bridges Cogitator runtime runs to A2A task lifecycle.
Supports create, execute, complete, fail, cancel with events."
```

---

## Task 8: A2AServer Core

**Files:**

- Create: `packages/a2a/src/server.ts`
- Create: `packages/a2a/src/__tests__/server.test.ts`

**Step 1: Write tests**

Test A2AServer:

- `handleRequest` with `message/send` → returns Task JSON-RPC response
- `handleRequest` with `tasks/get` → returns task
- `handleRequest` with `tasks/cancel` → cancels task
- `handleRequest` with unknown method → returns methodNotFound error
- `handleRequest` with invalid JSON-RPC → returns parseError
- `getAgentCard(agentName)` → returns generated card
- `getAgentCards()` → returns all cards
- Constructor validates at least one agent registered

Mock `Cogitator.run()` in tests — don't need real LLM calls.

**Step 2: Implement server.ts**

`A2AServer` class:

```ts
class A2AServer {
  constructor(config: A2AServerConfig);

  // framework-agnostic handlers
  async handleJsonRpc(body: unknown): Promise<JsonRpcResponse>;
  async handleJsonRpcStream(body: unknown): AsyncGenerator<A2AStreamEvent>;
  getAgentCard(agentName?: string): AgentCard;
  getAgentCards(): AgentCard[];

  // internal
  private routeMethod(method: string, params: unknown): Promise<unknown>;
  private handleSendMessage(params: SendMessageParams): Promise<A2ATask>;
  private handleGetTask(params: GetTaskParams): Promise<A2ATask>;
  private handleCancelTask(params: CancelTaskParams): Promise<A2ATask>;
}
```

Key: `A2AServer` is framework-agnostic. It takes raw JSON bodies and returns JSON responses. Framework adapters handle HTTP plumbing.

`A2AServerConfig`:

```ts
{
  agents: Record<string, IAgent>
  cogitator: Cogitator
  basePath?: string          // default '/a2a'
  taskStore?: TaskStore      // default InMemoryTaskStore
  cardUrl?: string           // base URL for agent card
  auth?: { type: 'bearer' | 'apiKey', validate: (credentials: string) => Promise<boolean> }
}
```

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): implement A2AServer with JSON-RPC routing

Framework-agnostic server handling message/send, tasks/get,
tasks/cancel. Auto-generates Agent Cards for all registered agents."
```

---

## Task 9: A2AServer SSE Streaming

**Files:**

- Modify: `packages/a2a/src/server.ts`
- Modify: `packages/a2a/src/__tests__/server.test.ts`

**Step 1: Write streaming tests**

Test cases:

- `handleJsonRpcStream` with `message/sendStream` → yields status updates then final task
- Stream includes initial `working` status event
- Stream includes `completed` status event at end
- Stream includes artifact events for structured output
- If agent fails, stream includes `failed` status event
- Stream terminates after terminal state

**Step 2: Implement streaming in server.ts**

Add `handleSendMessageStream` to A2AServer:

- Uses `cogitator.run(agent, { ...options, stream: true, onToken })` for streaming
- Yields `TaskStatusUpdateEvent` with state=working at start
- Yields `TaskArtifactUpdateEvent` as text accumulates (batched by chunks)
- Yields final `TaskStatusUpdateEvent` with state=completed/failed
- Uses `AsyncGenerator` pattern — adapters convert to SSE

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add SSE streaming support to A2AServer

message/sendStream returns AsyncGenerator of status and artifact
update events, bridging Cogitator's token streaming to A2A SSE."
```

---

## Task 10: A2AClient — Core

**Files:**

- Create: `packages/a2a/src/client.ts`
- Create: `packages/a2a/src/__tests__/client.test.ts`

**Step 1: Write tests**

Use a mock HTTP server (vitest can use `http.createServer` or mock `fetch`).

Test cases:

- `agentCard()` fetches from `/.well-known/agent.json`
- `sendMessage(message)` sends JSON-RPC to server, returns Task
- `getTask(id)` fetches task by ID
- `cancelTask(id)` cancels task
- Handles network errors gracefully
- Handles JSON-RPC error responses

**Step 2: Implement client.ts**

`A2AClient` class using native `fetch`:

```ts
class A2AClient {
  constructor(baseUrl: string, options?: A2AClientConfig);

  async agentCard(): Promise<AgentCard>;
  async sendMessage(message: A2AMessage, config?: SendMessageConfiguration): Promise<A2ATask>;
  async sendMessageStream(
    message: A2AMessage,
    config?: SendMessageConfiguration
  ): AsyncGenerator<A2AStreamEvent>;
  async getTask(taskId: string, historyLength?: number): Promise<A2ATask>;
  async cancelTask(taskId: string): Promise<A2ATask>;
  asTool(options?: AsToolOptions): Tool;
}
```

`A2AClientConfig`:

```ts
{
  headers?: Record<string, string>    // custom headers (auth tokens etc)
  timeout?: number                     // request timeout, default 30s
  agentCardPath?: string              // default '/.well-known/agent.json'
  rpcPath?: string                    // default '/a2a'
}
```

Internal: `rpc(method, params)` helper that wraps `fetch` + JSON-RPC envelope.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): implement A2AClient with discovery and task management

Native fetch-based client for A2A protocol. Supports agent card
discovery, message sending, task get/cancel."
```

---

## Task 11: A2AClient — SSE Streaming

**Files:**

- Modify: `packages/a2a/src/client.ts`
- Modify: `packages/a2a/src/__tests__/client.test.ts`

**Step 1: Write streaming tests**

Test `sendMessageStream`:

- Connects to SSE endpoint
- Yields parsed `TaskStatusUpdateEvent` events
- Yields parsed `TaskArtifactUpdateEvent` events
- Closes after terminal state
- Handles connection errors

**Step 2: Implement SSE parsing in client**

`sendMessageStream()`:

- Sends POST with `Accept: text/event-stream`
- Reads response body as `ReadableStream`
- Parses SSE frames (`data: ...\n\n`) line by line
- Yields parsed `A2AStreamEvent` objects
- Terminates on `[DONE]` or terminal task state

Uses `TextDecoderStream` + manual SSE line parsing (no external dep).

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add SSE streaming to A2AClient

Parses text/event-stream responses into typed A2AStreamEvent
objects via AsyncGenerator. Zero-dep SSE parsing."
```

---

## Task 12: A2AClient — asTool() Bridge

**Files:**

- Modify: `packages/a2a/src/client.ts`
- Modify: `packages/a2a/src/__tests__/client.test.ts`

**Step 1: Write tests**

Test `asTool()`:

- Returns a valid Cogitator `Tool` with name/description from Agent Card
- Tool `execute()` calls `sendMessage` on the client
- Tool returns `{ output, success: true }` on completion
- Tool returns `{ output: '', success: false, error }` on failure
- Tool has Zod schema `{ task: z.string() }` (same pattern as `agentAsTool`)

**Step 2: Implement asTool()**

```ts
asTool(options?: { name?: string, description?: string, timeout?: number }): Tool
```

- Fetches agent card if not cached (lazy, on first call)
- Creates `tool()` with:
  - `name` from `options.name ?? card.name`
  - `description` from `options.description ?? card.description ?? 'Remote A2A agent'`
  - `parameters: z.object({ task: z.string() })`
  - `execute` sends message via `this.sendMessage()`, awaits completion, returns `{ output, success }`
- Same return shape as `agentAsTool` from core — `{ output: string, success: boolean, error?: string }`

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add asTool() bridge to A2AClient

Wraps any remote A2A agent as a local Cogitator Tool.
Uses same interface as agentAsTool for seamless integration."
```

---

## Task 13: Express Adapter

**Files:**

- Create: `packages/a2a/src/adapters/express.ts`
- Create: `packages/a2a/src/__tests__/adapters/express.test.ts`

**Step 1: Write tests**

Test Express middleware:

- `GET /.well-known/agent.json` returns Agent Card JSON
- `POST /a2a` with valid JSON-RPC → returns JSON-RPC response
- `POST /a2a` with `message/sendStream` → returns SSE stream
- Invalid content-type → 400 error

Use `supertest` or raw Express `app.listen` for testing (check what existing Express adapter tests use first).

**Step 2: Implement express adapter**

```ts
export function a2aExpress(server: A2AServer): Router;
```

Creates Express `Router` with:

- `GET /.well-known/agent.json` → `res.json(server.getAgentCards())`
- `POST /a2a` → reads `req.body`, checks if streaming requested, either:
  - Calls `server.handleJsonRpc(body)` → `res.json(response)`
  - Calls `server.handleJsonRpcStream(body)` → sets `Content-Type: text/event-stream`, pipes events via `res.write()`

~50-80 lines total.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat(a2a): add Express adapter for A2A protocol

Thin Express Router wrapping A2AServer with Agent Card
discovery endpoint and JSON-RPC/SSE streaming support."
```

---

## Task 14: Hono Adapter

**Files:**

- Create: `packages/a2a/src/adapters/hono.ts`
- Create: `packages/a2a/src/__tests__/adapters/hono.test.ts`

**Step 1-4: Same pattern as Express**

```ts
export function a2aHono(server: A2AServer): Hono;
```

Uses Hono's `c.json()`, `c.text()`, `c.stream()` for responses.

**Step 5: Commit**

```bash
git commit -m "feat(a2a): add Hono adapter for A2A protocol"
```

---

## Task 15: Fastify Adapter

**Files:**

- Create: `packages/a2a/src/adapters/fastify.ts`
- Create: `packages/a2a/src/__tests__/adapters/fastify.test.ts`

**Step 1-4: Same pattern**

```ts
export function a2aFastify(server: A2AServer): FastifyPluginAsync;
```

Uses Fastify's `reply.send()`, `reply.raw` for SSE.

**Step 5: Commit**

```bash
git commit -m "feat(a2a): add Fastify adapter for A2A protocol"
```

---

## Task 16: Koa Adapter

**Files:**

- Create: `packages/a2a/src/adapters/koa.ts`
- Create: `packages/a2a/src/__tests__/adapters/koa.test.ts`

**Step 1-4: Same pattern**

```ts
export function a2aKoa(server: A2AServer): Middleware;
```

Uses Koa's `ctx.body`, `ctx.res` for SSE.

**Step 5: Commit**

```bash
git commit -m "feat(a2a): add Koa adapter for A2A protocol"
```

---

## Task 17: Next.js Adapter

**Files:**

- Create: `packages/a2a/src/adapters/next.ts`
- Create: `packages/a2a/src/__tests__/adapters/next.test.ts`

**Step 1-4: Same pattern**

```ts
export function a2aNext(server: A2AServer): { GET: NextHandler; POST: NextHandler };
```

Uses `NextResponse.json()`, `ReadableStream` for SSE.

**Step 5: Commit**

```bash
git commit -m "feat(a2a): add Next.js App Router adapter for A2A protocol"
```

---

## Task 18: Public API Exports

**Files:**

- Modify: `packages/a2a/src/index.ts`

**Step 1: Finalize barrel exports**

```ts
// Server
export { A2AServer } from './server';

// Client
export { A2AClient } from './client';

// Agent Card
export { generateAgentCard } from './agent-card';

// Task Store
export { InMemoryTaskStore } from './task-store';

// Task Manager
export { TaskManager } from './task-manager';

// JSON-RPC utilities
export {
  parseJsonRpcRequest,
  createSuccessResponse,
  createErrorResponse,
} from './json-rpc';

// Errors
export * from './errors';

// All types
export type { ... } from './types';
```

**Step 2: Build and verify**

Run: `pnpm --filter @cogitator-ai/a2a build`
Expected: Clean build, all exports resolve

**Step 3: Commit**

```bash
git commit -m "feat(a2a): finalize public API exports

Clean barrel file with server, client, stores, utilities,
errors, and all types exported."
```

---

## Task 19: Example — Two Cogitator Agents via A2A

**Files:**

- Create: `examples/a2a-basic.ts`

**Step 1: Write example**

Shows:

1. Create two agents (researcher + writer)
2. Start A2AServer with Express exposing the researcher
3. Create A2AClient pointing to the server
4. Use `client.asTool()` to wrap remote researcher
5. Give writer the remote researcher tool
6. Run writer — it delegates to researcher via A2A protocol

Include clear console output showing the A2A communication.

**Step 2: Verify it runs**

Run: `npx tsx examples/a2a-basic.ts`
Expected: Executes without errors (may need mock LLM or Ollama)

**Step 3: Commit**

```bash
git commit -m "feat(a2a): add basic A2A communication example

Two Cogitator agents communicating via A2A protocol —
demonstrates server, client, and asTool() bridge."
```

---

## Task 20: Example — External A2A Agent

**Files:**

- Create: `examples/a2a-external.ts`

**Step 1: Write example**

Shows connecting to any external A2A agent (e.g., a hypothetical public A2A endpoint). Demonstrates:

1. `A2AClient` discovery — fetch agent card
2. Inspect card capabilities and skills
3. Send a message
4. Handle streaming response

**Step 2: Commit**

```bash
git commit -m "feat(a2a): add external A2A agent connection example"
```

---

## Task 21: Update README

**Files:**

- Modify: Root `README.md`

**Step 1: Add A2A section to README**

Add to features list and create a section explaining A2A support:

- What is A2A protocol
- How Cogitator implements it
- Quick code example (server + client)
- Link to design doc

**Step 2: Commit**

```bash
git commit -m "docs(readme): add A2A protocol section

Document native A2A Protocol v0.3 support with examples
for server, client, and cross-agent communication."
```

---

## Task 22: Full Test Suite Run

**Step 1: Run all tests across monorepo**

Run: `pnpm test`
Expected: All packages pass

**Step 2: Run build across monorepo**

Run: `pnpm build`
Expected: Clean build for all packages

**Step 3: Fix any issues found**

---

## Summary

| Task      | What             | Est. Lines |
| --------- | ---------------- | ---------- |
| 1         | Package scaffold | ~50        |
| 2         | Types            | ~200       |
| 3         | JSON-RPC         | ~120       |
| 4         | Errors           | ~80        |
| 5         | Agent Card gen   | ~100       |
| 6         | TaskStore        | ~80        |
| 7         | Task Manager     | ~200       |
| 8         | Server core      | ~250       |
| 9         | Server streaming | ~100       |
| 10        | Client core      | ~200       |
| 11        | Client streaming | ~100       |
| 12        | Client asTool()  | ~60        |
| 13-17     | 5 adapters       | ~400       |
| 18        | Exports          | ~30        |
| 19-20     | Examples         | ~150       |
| 21        | README           | ~50        |
| **Total** |                  | **~2,170** |
