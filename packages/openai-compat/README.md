# @cogitator-ai/openai-compat

OpenAI Assistants API compatibility layer for Cogitator. Point the official OpenAI SDK (or any Assistants API client) at a Cogitator server, or drive the same assistants/threads/runs model in-process.

Full guide: [cogitator.app/docs/integrations/openai-compat](https://cogitator.app/docs/integrations/openai-compat)

## Installation

```bash
pnpm add @cogitator-ai/openai-compat @cogitator-ai/core

# optional: the OpenAI SDK for client code
pnpm add openai
```

`ioredis` and `pg` are optional peer dependencies, needed only for `RedisThreadStorage` / `PostgresThreadStorage`.

## Features

- **OpenAI Server** - Expose Cogitator as an OpenAI Assistants API (Fastify)
- **OpenAI Adapter** - In-process access to the same assistants/threads/runs API
- **Thread Manager** - Threads, messages, assistants and files over pluggable storage
- **Persistent Storage** - In-memory, Redis or PostgreSQL backends
- **SSE Streaming** - Token streaming with OpenAI-compatible stream events
- **Files** - Upload, list, download and delete files (`multipart/form-data`)
- **Function Calling** - Assistant `function` tools pause the run with `requires_action` until the client submits outputs
- **Server-side tools** - Cogitator tools passed to the server run inside Cogitator for every run
- **Vision & JSON output** - `image_url` / image `image_file` parts reach the model; `response_format` supports `json_object` and `json_schema`
- **Authentication** - Optional API keys (constant-time check, `/health` stays public)
- **CORS** - Configurable cross-origin requests

The package implements the Assistants API surface (models, assistants, threads, messages, runs, files). There is no `/v1/chat/completions`, run steps, or vector stores endpoint; `code_interpreter` and `file_search` assistant tools are stored but not executed.

---

## Quick Start

### Server Mode

```typescript
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  parameters: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ sum: a + b }),
});

const cogitator = new Cogitator({
  llm: { defaultModel: 'openai/gpt-6-luna' },
});

const server = createOpenAIServer(cogitator, {
  port: 8080,
  tools: [add],
  apiKeys: ['sk-my-secret-key'],
  defaultModel: 'openai/gpt-6-luna', // used for the advertised `cogitator` model id
});

await server.start();
console.log(server.getBaseUrl()); // http://localhost:8080/v1
```

### Client Mode

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'sk-my-secret-key',
});

const assistant = await openai.beta.assistants.create({
  name: 'Math Tutor',
  instructions: 'You help with math problems',
  model: 'ollama/llama3.2:latest',
});

const thread = await openai.beta.threads.create();

await openai.beta.threads.messages.create(thread.id, {
  role: 'user',
  content: 'What is 2 + 2?',
});

const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
  assistant_id: assistant.id,
});

const messages = await openai.beta.threads.messages.list(thread.id);
console.log(run.status, messages.data[0].content); // newest message first

// Streaming
const stream = openai.beta.threads.runs
  .stream(thread.id, { assistant_id: assistant.id })
  .on('textDelta', (delta) => process.stdout.write(delta.value ?? ''));
await stream.finalRun();
```

Assistant `model` values are Cogitator model strings (`openai/gpt-6.1-sol`, `ollama/llama3.2:latest`, ...). `GET /v1/models` lists a single model, `cogitator`, which maps to the server's `defaultModel`; runs that use it fail when no `defaultModel` is configured.

---

## OpenAI Server

The `OpenAIServer` exposes Cogitator as an OpenAI-compatible REST API.

### Configuration

```typescript
import { OpenAIServer } from '@cogitator-ai/openai-compat';

const server = new OpenAIServer(cogitator, {
  port: 8080,
  host: '0.0.0.0',

  apiKeys: ['sk-key1', 'sk-key2'],

  tools: [calculator, datetime, webSearch],

  logging: true,

  cors: {
    origin: ['http://localhost:3000', 'https://myapp.com'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  },
});
```

### Configuration Options

| Option         | Type                            | Default                                | Description                                      |
| -------------- | ------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `port`         | `number`                        | `8080`                                 | Port to listen on (`0` picks a free port)        |
| `host`         | `string`                        | `'0.0.0.0'`                            | Host to bind to                                  |
| `apiKeys`      | `string[]`                      | `[]`                                   | API keys for authentication. Empty disables auth |
| `tools`        | `Tool[]`                        | `[]`                                   | Server-side tools available to every run         |
| `defaultModel` | `string`                        | —                                      | Model used for the `cogitator` model id          |
| `storage`      | `ThreadStorage`                 | in-memory                              | Persistence backend (connect before passing)     |
| `maxFileSize`  | `number`                        | `512 MB`                               | Upload limit for `POST /v1/files`, in bytes      |
| `logging`      | `boolean`                       | `false`                                | Enable Fastify request logging (JSON logs)       |
| `cors.origin`  | `string \| string[] \| boolean` | `true`                                 | CORS origin configuration                        |
| `cors.methods` | `string[]`                      | `['GET', 'POST', 'DELETE', 'OPTIONS']` | Allowed HTTP methods                             |

### Server Lifecycle

```typescript
await server.start(); // throws if already started

console.log(server.getUrl()); // uses the bound port, so `port: 0` works
console.log(server.getBaseUrl()); // getUrl() + '/v1'

console.log(server.isRunning());

const adapter = server.getAdapter(); // the OpenAIAdapter behind the routes
const fastify = server.getFastify(); // underlying Fastify instance

await server.stop();
```

For tests without a listening socket, `await server.waitUntilReady()` and then call `server.getFastify().inject(...)`.

### Authentication

With `apiKeys` set, every request except `GET /health` needs `Authorization: Bearer <key>`. A missing header answers `401` with code `missing_api_key`; a malformed header or unknown key answers `401` with code `invalid_api_key`.

### Health Check

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

---

## OpenAI Adapter

The `OpenAIAdapter` provides in-process access without running a server. The server uses one internally (`server.getAdapter()`).

```typescript
import { createOpenAIAdapter } from '@cogitator-ai/openai-compat';

const adapter = createOpenAIAdapter(cogitator, {
  tools: [calculator], // server-side Cogitator tools
  defaultModel: 'openai/gpt-6-luna', // resolves the `cogitator` model id
  storage, // ThreadStorage, default: in-memory
  maxStoredRuns: 10_000, // finished runs kept in memory (default 10 000)
});
```

### Assistant Management

```typescript
const assistant = await adapter.createAssistant({
  model: 'openai/gpt-6.1-sol',
  name: 'Code Helper',
  description: 'Writes TypeScript',
  instructions: 'You help write code',
  temperature: 0.7,
  response_format: { type: 'json_object' },
  metadata: { category: 'development' },
});

const fetched = await adapter.getAssistant(assistant.id); // undefined if missing

const updated = await adapter.updateAssistant(assistant.id, {
  name: 'Code Expert',
  temperature: 0.5,
});

const all = await adapter.listAssistants();

const deleted = await adapter.deleteAssistant(assistant.id); // boolean
```

### Thread Operations

```typescript
const thread = await adapter.createThread({ project: 'demo' }); // metadata

const fetched = await adapter.getThread(thread.id);

await adapter.updateThread(thread.id, { metadata: { stage: 'review' } }); // merged into existing metadata

const message = await adapter.addMessage(thread.id, {
  role: 'user',
  content: 'Hello, how are you?',
  metadata: { source: 'web' },
});

const messages = await adapter.listMessages(thread.id, {
  limit: 20,
  order: 'asc',
  after: 'msg_abc123',
  before: 'msg_xyz789',
  run_id: 'run_123',
});

const msg = await adapter.getMessage(thread.id, 'msg_abc123');

await adapter.deleteThread(thread.id);
```

Message `content` is a string or an array of parts: `{ type: 'text', text }`, `{ type: 'image_url', image_url: { url } }` or `{ type: 'image_file', image_file: { file_id } }`.

### Run Execution

```typescript
const run = await adapter.createRun(thread.id, {
  assistant_id: assistant.id,
  model: 'openai/gpt-6.1-sol',
  instructions: 'Be concise',
  temperature: 0.5,
  additional_messages: [{ role: 'user', content: 'Extra context' }],
  metadata: { source: 'api' },
});

const status = adapter.getRun(thread.id, run.id); // synchronous

const runs = adapter.listRuns(thread.id); // newest first

const cancelled = adapter.cancelRun(thread.id, run.id); // throws if the run already finished

for await (const { event, data } of adapter.streamRunEvents(run.id)) {
  console.log(event, data);
}
```

`createRun` returns the `queued` run immediately and executes it in the background. It rejects when the assistant or thread is missing or the thread already has an active run (one active run per thread).

Runs use the whole thread as context (earlier messages are replayed to the agent), receive an abort signal on cancel, and honour `additional_instructions`, `response_format` (`json_object` / `json_schema`), `max_completion_tokens`, `top_p`, `tool_choice` (`none` or a specific function), `parallel_tool_calls` and `truncation_strategy` (`last_messages`). Image parts (`image_url`, and `image_file` uploads with a `png`/`jpg`/`jpeg`/`gif`/`webp` extension) are passed to the model.

`streamRunEvents(runId, fromIndex = 0)` replays the run's event log from `fromIndex` and ends after the next `done` event. `getRunEventCursor(runId)` returns the current log position (use it before `submitToolOutputs` to stream only the continuation), and `getStreamEmitter(runId)` exposes the raw `EventEmitter`. Token deltas are emitted only for runs created with `stream: true`.

Runs live in the adapter's memory, unlike assistants, threads, messages and files, which go to `storage`. Poll or cancel a run on the same process that created it.

### Tool Outputs

Server-side `tools` run inside Cogitator. Assistant tools of type `function` are executed by the API client: when the model calls one, the run moves to `requires_action` with the pending calls, and continues after all outputs are submitted (runs waiting longer than 10 minutes expire). Outputs must cover every pending call; missing or unknown `tool_call_id`s are rejected. With the OpenAI SDK use `submitToolOutputsAndPoll` / `submitToolOutputsStream`.

```typescript
const run = adapter.getRun(thread.id, runId);

if (run?.status === 'requires_action') {
  const toolCalls = run.required_action?.submit_tool_outputs.tool_calls ?? [];

  const outputs = await Promise.all(
    toolCalls.map(async (call) => ({
      tool_call_id: call.id,
      output: await executeMyTool(call.function.name, call.function.arguments),
    }))
  );

  await adapter.submitToolOutputs(thread.id, runId, {
    tool_outputs: outputs,
  });
}
```

---

## Thread Manager

The `ThreadManager` handles storage for threads, messages, assistants, and files. Get the adapter's instance with `adapter.getThreadManager()`, or create one directly.

```typescript
import { ThreadManager } from '@cogitator-ai/openai-compat';

const manager = new ThreadManager(); // or new ThreadManager(storage)
```

### Assistant Storage

```typescript
interface StoredAssistant {
  id: string;
  name: string | null;
  description?: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  metadata: Record<string, string>;
  temperature?: number;
  top_p?: number;
  response_format?: ResponseFormat;
  created_at: number;
}

const assistant = await manager.createAssistant({
  model: 'openai/gpt-6.1-sol',
  name: 'Helper',
  instructions: 'Be helpful',
});

const fetched = await manager.getAssistant(assistant.id);
const updated = await manager.updateAssistant(assistant.id, { name: 'Expert' });
const all = await manager.listAssistants();
await manager.deleteAssistant(assistant.id);
```

### Thread Storage

```typescript
const thread = await manager.createThread({ key: 'value' });
const fetched = await manager.getThread(thread.id);
await manager.updateThread(thread.id, { metadata: { key: 'other' } });
await manager.deleteThread(thread.id);
```

### Message Operations

```typescript
const message = await manager.addMessage(thread.id, {
  role: 'user',
  content: 'Hello!',
});

const assistantMsg = await manager.addAssistantMessage(
  thread.id,
  'Hi there!',
  assistant.id,
  run.id
  // optional 5th argument: message id to reuse
);

const messages = await manager.listMessages(thread.id, {
  limit: 50,
  order: 'desc',
});

const one = await manager.getMessage(thread.id, message!.id);

const llmMessages = await manager.getMessagesForLLM(thread.id); // { role, content, images? }[]
```

`addMessage` / `addAssistantMessage` resolve to `undefined` when the thread does not exist.

### File Management

```typescript
const file = await manager.addFile(Buffer.from('file content'), 'document.txt', 'assistants');

const fetched = await manager.getFile(file.id); // StoredFile with `content: Buffer`

const all = await manager.listFiles();

await manager.deleteFile(file.id);
```

---

## Persistent Storage

By default, ThreadManager uses in-memory storage. For production, use Redis or PostgreSQL backends.

### Storage Backends

```typescript
import {
  ThreadManager,
  InMemoryThreadStorage,
  RedisThreadStorage,
  PostgresThreadStorage,
  createThreadStorage,
} from '@cogitator-ai/openai-compat';
```

### In-Memory (Default)

```typescript
const manager = new ThreadManager();
// equivalent to:
const explicit = new ThreadManager(new InMemoryThreadStorage());
```

### Redis Storage

Requires the `ioredis` peer dependency:

```bash
pnpm add ioredis
```

```typescript
const storage = new RedisThreadStorage({
  host: 'localhost', // default: 'localhost'
  port: 6379, // default: 6379
  keyPrefix: 'cogitator:openai:', // default: 'cogitator:openai:'
  ttl: 86400, // seconds, default: 86400 (24h); 0 disables expiry
});
await storage.connect();

const manager = new ThreadManager(storage);

// When done:
await storage.disconnect();
```

With a connection URL (takes precedence over `host` / `port`):

```typescript
const storage = new RedisThreadStorage({
  url: 'redis://user:pass@localhost:6379/0',
});
```

### PostgreSQL Storage

Requires the `pg` peer dependency:

```bash
pnpm add pg
```

```typescript
const storage = new PostgresThreadStorage({
  connectionString: 'postgresql://user:pass@localhost:5432/db',
  schema: 'public', // default: 'public'
  tableName: 'openai_compat_data', // default: 'openai_compat_data'
});
await storage.connect(); // creates the table and index if missing

const manager = new ThreadManager(storage);

// When done:
await storage.disconnect();
```

`schema` and `tableName` must be plain SQL identifiers (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`); the constructor throws otherwise.

### Factory Function

```typescript
const memory = createThreadStorage(); // or createThreadStorage({ type: 'memory' })

const redis = createThreadStorage({
  type: 'redis',
  host: 'localhost',
  port: 6379,
});
await redis.connect?.();

const postgres = createThreadStorage({
  type: 'postgres',
  connectionString: 'postgresql://localhost/db',
});
await postgres.connect?.();
```

The factory returns an unconnected `ThreadStorage`; call `connect()` before use.

### Using with the Adapter or Server

```typescript
import { OpenAIAdapter, RedisThreadStorage, createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Cogitator } from '@cogitator-ai/core';

const storage = new RedisThreadStorage({ host: 'localhost' });
await storage.connect();

const cogitator = new Cogitator({ llm: { defaultModel: 'openai/gpt-6.1-sol' } });

// In-process adapter backed by Redis
const adapter = new OpenAIAdapter(cogitator, { tools: [], storage });

// Or the REST server
const server = createOpenAIServer(cogitator, { storage });
```

Storage is the single source of truth for assistants, threads, messages and files (no in-process cache), so several server instances can share one Redis or PostgreSQL backend. Runs are not persisted: they stay in the memory of the instance that executes them. Redis listings use `SCAN` + `MGET`. `ioredis` and `pg` are loaded on `connect()`, with an install hint if missing.

### ThreadStorage Interface

All storage backends implement this interface:

```typescript
interface ThreadStorage {
  // Threads
  saveThread(id: string, thread: StoredThread): Promise<void>;
  loadThread(id: string): Promise<StoredThread | null>;
  deleteThread(id: string): Promise<boolean>;
  listThreads(): Promise<StoredThread[]>;

  // Assistants
  saveAssistant(id: string, assistant: StoredAssistant): Promise<void>;
  loadAssistant(id: string): Promise<StoredAssistant | null>;
  deleteAssistant(id: string): Promise<boolean>;
  listAssistants(): Promise<StoredAssistant[]>;

  // Files
  saveFile(id: string, file: StoredFile): Promise<void>;
  loadFile(id: string): Promise<StoredFile | null>;
  deleteFile(id: string): Promise<boolean>;
  listFiles(): Promise<StoredFile[]>;

  // Lifecycle (optional)
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}
```

`StoredThread` is `{ thread: Thread; messages: Message[] }`; `StoredFile` is `{ id, content: Buffer, filename, created_at, purpose? }`.

### Custom Storage Implementation

```typescript
import type { ThreadStorage, StoredThread } from '@cogitator-ai/openai-compat';

class MyCustomStorage implements ThreadStorage {
  async saveThread(id: string, thread: StoredThread): Promise<void> {
    // Your implementation
  }
  // ... implement all methods
}

const manager = new ThreadManager(new MyCustomStorage());
```

---

## Supported Endpoints

All endpoints except `/health` live under `/v1`. List endpoints for assistants, messages and runs accept `limit` (1-100, default 20), `order` (`asc` / `desc`, default `desc`), `after` and `before`, and return `{ object: 'list', data, first_id, last_id, has_more }`.

### Models

| Method | Endpoint     | Description                        |
| ------ | ------------ | ---------------------------------- |
| GET    | `/v1/models` | Lists the single `cogitator` model |
| GET    | `/health`    | Health check (public, no auth)     |

### Assistants

| Method | Endpoint             | Description      |
| ------ | -------------------- | ---------------- |
| POST   | `/v1/assistants`     | Create assistant |
| GET    | `/v1/assistants`     | List assistants  |
| GET    | `/v1/assistants/:id` | Get assistant    |
| POST   | `/v1/assistants/:id` | Update assistant |
| DELETE | `/v1/assistants/:id` | Delete assistant |

### Threads

| Method | Endpoint          | Description                                 |
| ------ | ----------------- | ------------------------------------------- |
| POST   | `/v1/threads`     | Create thread (optional initial `messages`) |
| GET    | `/v1/threads/:id` | Get thread                                  |
| POST   | `/v1/threads/:id` | Update thread metadata (merged)             |
| DELETE | `/v1/threads/:id` | Delete thread                               |

### Messages

| Method | Endpoint                           | Description                           |
| ------ | ---------------------------------- | ------------------------------------- |
| POST   | `/v1/threads/:id/messages`         | Add message (`user` or `assistant`)   |
| GET    | `/v1/threads/:id/messages`         | List messages (also filters `run_id`) |
| GET    | `/v1/threads/:id/messages/:msg_id` | Get message                           |

### Runs

| Method | Endpoint                                           | Description         |
| ------ | -------------------------------------------------- | ------------------- |
| POST   | `/v1/threads/runs`                                 | Create thread + run |
| POST   | `/v1/threads/:id/runs`                             | Create run          |
| GET    | `/v1/threads/:id/runs`                             | List runs           |
| GET    | `/v1/threads/:id/runs/:run_id`                     | Get run status      |
| POST   | `/v1/threads/:id/runs/:run_id/cancel`              | Cancel run          |
| POST   | `/v1/threads/:id/runs/:run_id/submit_tool_outputs` | Submit tool outputs |

The create and `submit_tool_outputs` endpoints stream SSE when the body has `stream: true`.

### Files

| Method | Endpoint                | Description                                 |
| ------ | ----------------------- | ------------------------------------------- |
| POST   | `/v1/files`             | Upload file (`multipart/form-data`)         |
| GET    | `/v1/files`             | List files, newest first (`purpose` filter) |
| GET    | `/v1/files/:id`         | Get file metadata                           |
| GET    | `/v1/files/:id/content` | Download file content                       |
| DELETE | `/v1/files/:id`         | Delete file                                 |

Uploads take a `file` part and an optional `purpose` field (`assistants`, `assistants_output`, `batch`, `batch_output`, `fine-tune`, `fine-tune-results`, `vision`; default `assistants`).

---

## Error Handling

The server returns OpenAI-compatible error responses:

```typescript
interface OpenAIError {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}
```

`formatOpenAIError(code, message, type?, param?)` builds this shape if you add your own routes via `server.getFastify()`.

### Error Types

| HTTP Status | Type                    | Code                                 | When                                                   |
| ----------- | ----------------------- | ------------------------------------ | ------------------------------------------------------ |
| 400         | `invalid_request_error` | `invalid_request`, `missing_file`    | Invalid parameters, unknown assistant, thread busy     |
| 401         | `invalid_request_error` | `missing_api_key`, `invalid_api_key` | Missing, malformed or unknown API key                  |
| 404         | `invalid_request_error` | `not_found`                          | Unknown thread, message, run, assistant, file or route |
| 429         | `rate_limit_error`      | `rate_limit_exceeded`                | Errors thrown with status 429                          |
| 500         | `server_error`          | `internal_error`                     | Unhandled errors                                       |

A run that fails during execution does not produce an HTTP error: it ends with `status: 'failed'` and `last_error: { code: 'server_error', message }`.

### Client-Side Error Handling

```typescript
try {
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: 'invalid-id',
  });
} catch (error) {
  if (error instanceof OpenAI.APIError) {
    console.log(error.status); // 400
    console.log(error.message);
    console.log(error.code); // 'invalid_request'
  }
}
```

---

## Run Status

Runs go through the following states:

```typescript
type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'requires_action'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'
  | 'incomplete'
  | 'expired';
```

### Status Flow

```
queued → in_progress → completed
                     → failed
                     → requires_action → in_progress → ...
                                       → expired (no outputs within 10 minutes)

queued / in_progress / requires_action → cancelling → cancelled
```

`incomplete` is part of the type for OpenAI parity but is never produced.

### Polling for Completion

```typescript
import OpenAI from 'openai';

async function waitForRun(
  openai: OpenAI,
  threadId: string,
  runId: string
): Promise<OpenAI.Beta.Threads.Run> {
  const terminalStates = ['completed', 'failed', 'cancelled', 'expired', 'requires_action'];

  while (true) {
    const run = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });

    if (terminalStates.includes(run.status)) {
      return run;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

The SDK's `createAndPoll` / `submitToolOutputsAndPoll` do the same.

---

## SSE Streaming

Runs created with `stream: true` answer with Server-Sent Events and stream tokens as they are generated.

### Streaming with OpenAI SDK

```typescript
const run = await openai.beta.threads.runs.create(threadId, {
  assistant_id: assistant.id,
  stream: true,
});

for await (const event of run) {
  if (event.event === 'thread.message.delta') {
    for (const content of event.data.delta.content ?? []) {
      if (content.type === 'text' && content.text?.value) {
        process.stdout.write(content.text.value);
      }
    }
  }
}
```

### Create Thread and Run with Streaming

```typescript
const run = await openai.beta.threads.createAndRun({
  assistant_id: assistant.id,
  thread: {
    messages: [{ role: 'user', content: 'Hello!' }],
  },
  stream: true,
});

for await (const event of run) {
  console.log(event.event, event.data);
}
```

### Stream Events

The server emits these events (the exported `StreamEventType` union also lists run-step events, which are not emitted):

```typescript
type EmittedEvent =
  | { event: 'thread.run.created'; data: Run }
  | { event: 'thread.run.queued'; data: Run }
  | { event: 'thread.run.in_progress'; data: Run }
  | { event: 'thread.run.requires_action'; data: Run }
  | { event: 'thread.run.completed'; data: Run }
  | { event: 'thread.run.failed'; data: Run }
  | { event: 'thread.run.cancelling'; data: Run }
  | { event: 'thread.run.cancelled'; data: Run }
  | { event: 'thread.run.expired'; data: Run }
  | { event: 'thread.message.created'; data: Message }
  | { event: 'thread.message.in_progress'; data: Message }
  | { event: 'thread.message.delta'; data: MessageDelta }
  | { event: 'thread.message.completed'; data: Message }
  | { event: 'done'; data: '[DONE]' };
```

A stream ends with `done` after the run finishes or pauses on `requires_action`; continue a paused run with `submit_tool_outputs` and `stream: true`, which streams only the events after the submission.

### Message Delta Format

All text deltas target content index `0`, so SDK helpers accumulate them into a single text part whose message id matches the stored message.

```typescript
interface MessageDelta {
  id: string;
  object: 'thread.message.delta';
  delta: {
    content?: {
      index: number;
      type: 'text';
      text?: { value?: string };
    }[];
  };
}
```

### Raw SSE Endpoint

For non-SDK usage, the SSE stream is available at:

```
POST /v1/threads/{thread_id}/runs
Content-Type: application/json

{
  "assistant_id": "asst_xxx",
  "stream": true
}
```

Response format (Server-Sent Events):

```
event: thread.run.created
data: {"id":"run_xxx","status":"queued",...}

event: thread.run.queued
data: {"id":"run_xxx","status":"queued",...}

event: thread.run.in_progress
data: {"id":"run_xxx","status":"in_progress",...}

event: thread.message.created
data: {"id":"msg_xxx","status":"in_progress",...}

event: thread.message.in_progress
data: {"id":"msg_xxx","status":"in_progress",...}

event: thread.message.delta
data: {"id":"msg_xxx","object":"thread.message.delta","delta":{"content":[{"index":0,"type":"text","text":{"value":"Hello"}}]}}

event: thread.message.delta
data: {"id":"msg_xxx","object":"thread.message.delta","delta":{"content":[{"index":0,"type":"text","text":{"value":" world"}}]}}

event: thread.message.completed
data: {"id":"msg_xxx","status":"completed",...}

event: thread.run.completed
data: {"id":"run_xxx","status":"completed",...}

event: done
data: [DONE]
```

---

## Type Reference

### Server & Adapter

```typescript
import type {
  OpenAIServerConfig,
  AuthConfig,
  OpenAIAdapterOptions,
  StreamEventType,
  StreamEventData,
  StreamEmitterEvents,
  RunStreamEvent,
  LLMThreadMessage,
  CreateAssistantParams,
  UpdateAssistantParams,
} from '@cogitator-ai/openai-compat';

import { COGITATOR_MODEL_ID, formatOpenAIError } from '@cogitator-ai/openai-compat';
```

### Core Types

```typescript
import type {
  OpenAIError,
  ListResponse,
  Assistant,
  AssistantTool,
  FunctionDefinition,
  ResponseFormat,
  JsonSchema,
  CreateAssistantRequest,
  UpdateAssistantRequest,
} from '@cogitator-ai/openai-compat';
```

### Thread Types

```typescript
import type { Thread, ToolResources, CreateThreadRequest } from '@cogitator-ai/openai-compat';
```

### Message Types

```typescript
import type {
  Message,
  MessageContent,
  TextContent,
  TextAnnotation,
  ImageFileContent,
  ImageUrlContent,
  Attachment,
  CreateMessageRequest,
  MessageContentPart,
} from '@cogitator-ai/openai-compat';
```

### Run Types

```typescript
import type {
  Run,
  RunStatus,
  RequiredAction,
  ToolCall,
  RunError,
  Usage,
  ToolChoice,
  IncompleteDetails,
  TruncationStrategy,
  CreateRunRequest,
  SubmitToolOutputsRequest,
  ToolOutput,
} from '@cogitator-ai/openai-compat';
```

### Run Step Types

```typescript
import type { RunStep, StepDetails, StepToolCall, RunStepDelta } from '@cogitator-ai/openai-compat';
```

### File Types

```typescript
import type { FileObject, FilePurpose, UploadFileRequest } from '@cogitator-ai/openai-compat';
```

### Stream Types

```typescript
import type {
  StreamEvent,
  MessageDelta,
  MessageContentDelta,
  RunStepDelta,
} from '@cogitator-ai/openai-compat';
```

### Storage Types

```typescript
import type {
  ThreadStorage,
  StoredThread,
  StoredAssistant,
  StoredFile,
  RedisThreadStorageConfig,
  PostgresThreadStorageConfig,
} from '@cogitator-ai/openai-compat';

import {
  InMemoryThreadStorage,
  RedisThreadStorage,
  PostgresThreadStorage,
  createThreadStorage,
} from '@cogitator-ai/openai-compat';
```

---

## Examples

### Chat Bot with Memory

```typescript
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Cogitator } from '@cogitator-ai/core';
import OpenAI from 'openai';

const cogitator = new Cogitator({
  llm: { defaultModel: 'ollama/llama3.2:latest' },
});

const server = createOpenAIServer(cogitator, { port: 8080 });
await server.start();

const openai = new OpenAI({
  baseURL: server.getBaseUrl(),
  apiKey: 'not-needed',
});

const assistant = await openai.beta.assistants.create({
  name: 'Chat Bot',
  instructions: 'You are a friendly chat bot. Remember previous messages.',
  model: 'ollama/llama3.2:latest',
});

const thread = await openai.beta.threads.create();

async function chat(message: string): Promise<string> {
  await openai.beta.threads.messages.create(thread.id, {
    role: 'user',
    content: message,
  });

  const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
    assistant_id: assistant.id,
  });
  if (run.status !== 'completed') throw new Error(run.last_error?.message ?? run.status);

  const messages = await openai.beta.threads.messages.list(thread.id, {
    limit: 1,
    order: 'desc',
  });

  const content = messages.data[0].content[0];
  return content.type === 'text' ? content.text.value : '';
}

console.log(await chat('Hi, my name is Alex'));
console.log(await chat('What is my name?'));
```

### Server-Side Tools

```typescript
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import OpenAI from 'openai';

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up an order by id',
  parameters: z.object({
    orderId: z.string().describe('Order id'),
  }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const cogitator = new Cogitator({
  llm: { defaultModel: 'openai/gpt-6.1-sol' },
});

const server = createOpenAIServer(cogitator, {
  port: 8080,
  tools: [lookupOrder],
});

await server.start();

const openai = new OpenAI({
  baseURL: server.getBaseUrl(),
  apiKey: 'not-needed',
});

const assistant = await openai.beta.assistants.create({
  name: 'Support Bot',
  instructions: 'Use lookup_order to answer questions about orders.',
  model: 'openai/gpt-6.1-sol',
});
// Server-side tools (`tools` on the server) are available to every run without
// being declared on the assistant. Declare `function` tools only for functions
// your client executes (they surface as `requires_action`).
```

### Client-Executed Function Tools

```typescript
const assistant = await openai.beta.assistants.create({
  model: 'openai/gpt-6.1-sol',
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ],
});

let run = await openai.beta.threads.runs.createAndPoll(thread.id, {
  assistant_id: assistant.id,
});

while (run.status === 'requires_action' && run.required_action) {
  const tool_outputs = run.required_action.submit_tool_outputs.tool_calls.map((call) => ({
    tool_call_id: call.id,
    output: JSON.stringify({ city: JSON.parse(call.function.arguments).city, tempC: 21 }),
  }));
  run = await openai.beta.threads.runs.submitToolOutputsAndPoll(run.id, {
    thread_id: thread.id,
    tool_outputs,
  });
}
```

### File Upload

```typescript
import fs from 'node:fs';
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'key',
});

const file = await openai.files.create({
  file: fs.createReadStream('data.csv'),
  purpose: 'assistants',
});

console.log('Uploaded:', file.id);

const content = await openai.files.content(file.id);
console.log('Content:', await content.text());

await openai.files.delete(file.id);
```

### Multi-Model Setup

```typescript
const cogitator = new Cogitator({
  llm: { defaultModel: 'ollama/llama3.2:latest' },
});

const server = createOpenAIServer(cogitator, { port: 8080 });
await server.start();

const openai = new OpenAI({
  baseURL: server.getBaseUrl(),
  apiKey: 'not-needed',
});

const localAssistant = await openai.beta.assistants.create({
  name: 'Local Assistant',
  model: 'ollama/llama3.2:latest',
  instructions: 'Fast local responses',
});

const cloudAssistant = await openai.beta.assistants.create({
  name: 'Cloud Assistant',
  model: 'openai/gpt-6.1-sol',
  instructions: 'Complex reasoning tasks',
});
```

---

## License

MIT
