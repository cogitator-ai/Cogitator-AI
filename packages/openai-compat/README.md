# @cogitator-ai/openai-compat

OpenAI Assistants API compatibility layer for Cogitator. Use OpenAI SDK clients with Cogitator backend, or integrate Cogitator with existing OpenAI-based applications.

## Installation

```bash
pnpm add @cogitator-ai/openai-compat
```

## Features

- **OpenAI Server** - Expose Cogitator as OpenAI-compatible REST API
- **OpenAI Adapter** - In-process adapter for programmatic access
- **Thread Manager** - Manage conversations, messages, and assistants
- **Persistent Storage** - Pluggable backends: In-memory, Redis, PostgreSQL
- **SSE Streaming** - Real-time token streaming with OpenAI-compatible events
- **File Operations** - Upload and manage files for assistants
- **Full Assistants API** - Create, update, delete assistants
- **Run Management** - Execute, stream, cancel and list runs
- **Function Calling** - Assistant `function` tools pause the run with `requires_action` until the client submits outputs
- **Authentication** - Optional API key authentication
- **CORS Support** - Configurable cross-origin requests

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

Assistant `model` values are Cogitator model strings (`openai/gpt-6.1-sol`, `ollama/llama3.2:latest`, ...). The id `cogitator` listed by `GET /v1/models` maps to the server's `defaultModel`.

---

## OpenAI Server

The `OpenAIServer` exposes Cogitator as an OpenAI-compatible REST API.

### Configuration

```typescript
import { OpenAIServer, createOpenAIServer } from '@cogitator-ai/openai-compat';

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
| `port`         | `number`                        | `8080`                                 | Port to listen on                                |
| `host`         | `string`                        | `'0.0.0.0'`                            | Host to bind to                                  |
| `apiKeys`      | `string[]`                      | `[]`                                   | API keys for authentication. Empty disables auth |
| `tools`        | `Tool[]`                        | `[]`                                   | Server-side tools available to every run         |
| `defaultModel` | `string`                        | —                                      | Model used for the `cogitator` model id          |
| `storage`      | `ThreadStorage`                 | in-memory                              | Persistence backend (connect before passing)     |
| `maxFileSize`  | `number`                        | `512 MB`                               | Upload limit for `POST /v1/files`                |
| `logging`      | `boolean`                       | `false`                                | Enable Fastify request logging (JSON logs)       |
| `cors.origin`  | `string \| string[] \| boolean` | `true`                                 | CORS origin configuration                        |
| `cors.methods` | `string[]`                      | `['GET', 'POST', 'DELETE', 'OPTIONS']` | Allowed HTTP methods                             |

### Server Lifecycle

```typescript
await server.start();

console.log(server.getUrl()); // uses the bound port, so `port: 0` works
console.log(server.getBaseUrl());

console.log(server.isRunning());

const adapter = server.getAdapter();

await server.stop();
```

### Health Check

The server provides a health endpoint (public even when `apiKeys` are configured):

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

---

## OpenAI Adapter

The `OpenAIAdapter` provides in-process access without running a server.

```typescript
import { OpenAIAdapter, createOpenAIAdapter } from '@cogitator-ai/openai-compat';

const adapter = createOpenAIAdapter(cogitator, {
  tools: [calculator],
});
```

### Assistant Management

```typescript
const assistant = await adapter.createAssistant({
  model: 'openai/gpt-6.1-sol',
  name: 'Code Helper',
  instructions: 'You help write code',
  temperature: 0.7,
  tools: [{ type: 'code_interpreter' }],
  metadata: { category: 'development' },
});

const fetched = await adapter.getAssistant(assistant.id);

const updated = await adapter.updateAssistant(assistant.id, {
  name: 'Code Expert',
  temperature: 0.5,
});

const all = await adapter.listAssistants();

const deleted = await adapter.deleteAssistant(assistant.id);
```

### Thread Operations

```typescript
const thread = await adapter.createThread({ project: 'demo' });

const fetched = await adapter.getThread(thread.id);

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

const status = adapter.getRun(thread.id, run.id);

const runs = adapter.listRuns(thread.id);

const cancelled = adapter.cancelRun(thread.id, run.id); // throws if the run already finished

for await (const { event, data } of adapter.streamRunEvents(run.id)) {
  console.log(event, data);
}
```

Runs use the whole thread as context (earlier messages are replayed to the agent), receive an abort signal on cancel, and honour `additional_instructions`, `response_format` (`json_object` / `json_schema`), `max_completion_tokens`, `top_p`, `tool_choice` (`none` or a specific function), `parallel_tool_calls` and `truncation_strategy` (`last_messages`). A thread can have only one active run at a time. Image parts (`image_url`, and `image_file` uploads with an image extension) are passed to the model.

### Tool Outputs

Server-side `tools` run inside Cogitator. Assistant tools of type `function` are executed by the API client: when the model calls one, the run moves to `requires_action` with the pending calls, and continues after all outputs are submitted (runs waiting longer than 10 minutes expire). With the OpenAI SDK use `submitToolOutputsAndPoll` / `submitToolOutputsStream`.

```typescript
const run = adapter.getRun(thread.id, runId);

if (run?.status === 'requires_action') {
  const toolCalls = run.required_action?.submit_tool_outputs.tool_calls;

  const outputs = await Promise.all(
    toolCalls!.map(async (call) => ({
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

The `ThreadManager` handles storage for threads, messages, assistants, and files.

```typescript
import { ThreadManager } from '@cogitator-ai/openai-compat';

const manager = new ThreadManager();
```

### Assistant Storage

```typescript
interface StoredAssistant {
  id: string;
  name: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  metadata: Record<string, string>;
  temperature?: number;
  created_at: number;
}

const assistant = await manager.createAssistant({
  model: 'gpt-6.1-sol',
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
);

const messages = await manager.listMessages(thread.id, {
  limit: 50,
  order: 'desc',
});

const llmMessages = await manager.getMessagesForLLM(thread.id);
```

### File Management

```typescript
const file = await manager.addFile(Buffer.from('file content'), 'document.txt');

const fetched = await manager.getFile(file.id);

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
// or explicitly:
const manager = new ThreadManager(new InMemoryThreadStorage());
```

### Redis Storage

Requires `ioredis` peer dependency:

```bash
pnpm add ioredis
```

```typescript
const storage = new RedisThreadStorage({
  host: 'localhost',
  port: 6379,
  keyPrefix: 'cogitator:openai:', // optional, default: 'cogitator:openai:'
  ttl: 86400, // optional, default: 86400 (24h)
});
await storage.connect();

const manager = new ThreadManager(storage);

// When done:
await storage.disconnect();
```

With connection URL:

```typescript
const storage = new RedisThreadStorage({
  url: 'redis://user:pass@localhost:6379/0',
});
```

### PostgreSQL Storage

Requires `pg` peer dependency:

```bash
pnpm add pg
```

```typescript
const storage = new PostgresThreadStorage({
  connectionString: 'postgresql://user:pass@localhost:5432/db',
  schema: 'public', // optional, default: 'public'
  tableName: 'openai_compat_data', // optional, default: 'openai_compat_data'
});
await storage.connect();

const manager = new ThreadManager(storage);

// When done:
await storage.disconnect();
```

### Factory Function

```typescript
// In-memory (default)
const storage = createThreadStorage();
// or: createThreadStorage({ type: 'memory' })

// Redis
const storage = createThreadStorage({
  type: 'redis',
  host: 'localhost',
  port: 6379,
});
await storage.connect!();

// PostgreSQL
const storage = createThreadStorage({
  type: 'postgres',
  connectionString: 'postgresql://localhost/db',
});
await storage.connect!();
```

### Using with OpenAI Adapter

```typescript
import { OpenAIAdapter, ThreadManager, RedisThreadStorage } from '@cogitator-ai/openai-compat';
import { Cogitator } from '@cogitator-ai/core';

const storage = new RedisThreadStorage({ host: 'localhost' });
await storage.connect();

const cogitator = new Cogitator({ llm: { defaultModel: 'openai/gpt-6.1-sol' } });

// In-process adapter backed by Redis
const adapter = new OpenAIAdapter(cogitator, { tools: [], storage });

// Or the REST server
const server = createOpenAIServer(cogitator, { storage });
```

Storage is the single source of truth (no in-process cache), so several server instances can share one Redis or PostgreSQL backend. Redis listings use `SCAN` + `MGET`; `ttl: 0` disables expiry. `ioredis` and `pg` are optional peer dependencies loaded on `connect()`.

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

### Custom Storage Implementation

```typescript
import type { ThreadStorage } from '@cogitator-ai/openai-compat';

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

### Models

| Method | Endpoint     | Description           |
| ------ | ------------ | --------------------- |
| GET    | `/v1/models` | List available models |

### Assistants

| Method | Endpoint             | Description      |
| ------ | -------------------- | ---------------- |
| POST   | `/v1/assistants`     | Create assistant |
| GET    | `/v1/assistants`     | List assistants  |
| GET    | `/v1/assistants/:id` | Get assistant    |
| POST   | `/v1/assistants/:id` | Update assistant |
| DELETE | `/v1/assistants/:id` | Delete assistant |

### Threads

| Method | Endpoint          | Description            |
| ------ | ----------------- | ---------------------- |
| POST   | `/v1/threads`     | Create thread          |
| GET    | `/v1/threads/:id` | Get thread             |
| POST   | `/v1/threads/:id` | Update thread metadata |
| DELETE | `/v1/threads/:id` | Delete thread          |

### Messages

| Method | Endpoint                           | Description   |
| ------ | ---------------------------------- | ------------- |
| POST   | `/v1/threads/:id/messages`         | Add message   |
| GET    | `/v1/threads/:id/messages`         | List messages |
| GET    | `/v1/threads/:id/messages/:msg_id` | Get message   |

### Runs

| Method | Endpoint                                           | Description         |
| ------ | -------------------------------------------------- | ------------------- |
| POST   | `/v1/threads/runs`                                 | Create thread + run |
| POST   | `/v1/threads/:id/runs`                             | Create run          |
| GET    | `/v1/threads/:id/runs`                             | List runs           |
| GET    | `/v1/threads/:id/runs/:run_id`                     | Get run status      |
| POST   | `/v1/threads/:id/runs/:run_id/cancel`              | Cancel run          |
| POST   | `/v1/threads/:id/runs/:run_id/submit_tool_outputs` | Submit tool outputs |

### Files

| Method | Endpoint                | Description           |
| ------ | ----------------------- | --------------------- |
| POST   | `/v1/files`             | Upload file           |
| GET    | `/v1/files`             | List files            |
| GET    | `/v1/files/:id`         | Get file metadata     |
| GET    | `/v1/files/:id/content` | Download file content |
| DELETE | `/v1/files/:id`         | Delete file           |

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

### Error Types

| HTTP Status | Type                    | Description                |
| ----------- | ----------------------- | -------------------------- |
| 400         | `invalid_request_error` | Invalid request parameters |
| 401         | `authentication_error`  | Invalid or missing API key |
| 404         | `invalid_request_error` | Resource not found         |
| 500         | `server_error`          | Internal server error      |

### Client-Side Error Handling

```typescript
try {
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: 'invalid-id',
  });
} catch (error) {
  if (error instanceof OpenAI.APIError) {
    console.log(error.status);
    console.log(error.message);
    console.log(error.code);
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

Streaming runs (`stream: true`) emit `thread.run.created`, `thread.run.queued`, `thread.run.in_progress`, `thread.message.created`, `thread.message.delta`, `thread.message.completed`, `thread.run.completed` (or `failed` / `cancelled` / `expired` / `requires_action`) and a final `done` event.

### Polling for Completion

```typescript
async function waitForRun(openai: OpenAI, threadId: string, runId: string): Promise<Run> {
  const terminalStates = ['completed', 'failed', 'cancelled', 'expired'];

  while (true) {
    const run = await openai.beta.threads.runs.retrieve(runId, { thread_id: threadId });

    if (terminalStates.includes(run.status)) {
      return run;
    }

    if (run.status === 'requires_action') {
      return run;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

---

## SSE Streaming

Real-time streaming support with Server-Sent Events (SSE). Streams tokens as they are generated for immediate feedback.

### Streaming with OpenAI SDK

```typescript
const run = await openai.beta.threads.runs.create(threadId, {
  assistant_id: assistant.id,
  stream: true, // Enable streaming
});

// Handle streaming events
for await (const event of run) {
  if (event.event === 'thread.message.delta') {
    const delta = event.data.delta;
    if (delta.content) {
      for (const content of delta.content) {
        if (content.type === 'text' && content.text?.value) {
          process.stdout.write(content.text.value);
        }
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

// Process stream
for await (const event of run) {
  console.log(event.event, event.data);
}
```

### Stream Events

```typescript
type StreamEvent =
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

A stream ends with `done` after the run finishes or pauses on `requires_action`; continue a paused run with `submit_tool_outputs` and `stream: true`.

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

event: thread.run.in_progress
data: {"id":"run_xxx","status":"in_progress",...}

event: thread.message.created
data: {"id":"msg_xxx","status":"in_progress",...}

event: thread.message.delta
data: {"id":"msg_xxx","delta":{"content":[{"index":0,"type":"text","text":{"value":"Hello"}}]}}

event: thread.message.delta
data: {"id":"msg_xxx","delta":{"content":[{"index":1,"type":"text","text":{"value":" world"}}]}}

event: thread.message.completed
data: {"id":"msg_xxx","status":"completed",...}

event: thread.run.completed
data: {"id":"run_xxx","status":"completed",...}

event: done
data: [DONE]
```

---

## Type Reference

### Core Types

```typescript
import type {
  OpenAIError,
  ListResponse,
  Assistant,
  AssistantTool,
  FunctionDefinition,
  ResponseFormat,
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
  Attachment,
  CreateMessageRequest,
  MessageContentPart,
  MessageDelta,
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
import type { StreamEvent, MessageDelta, RunStepDelta } from '@cogitator-ai/openai-compat';
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

### Code Assistant with Tools

```typescript
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import OpenAI from 'openai';

const runCode = tool({
  name: 'run_code',
  description: 'Execute Python code',
  parameters: z.object({
    code: z.string().describe('Python code to execute'),
  }),
  execute: async ({ code }) => {
    return `Output: ${code.length} characters`;
  },
});

const cogitator = new Cogitator({
  llm: { defaultModel: 'openai/gpt-6.1-sol' },
});

const server = createOpenAIServer(cogitator, {
  port: 8080,
  tools: [runCode],
});

await server.start();

const openai = new OpenAI({
  baseURL: server.getBaseUrl(),
  apiKey: process.env.OPENAI_API_KEY,
});

const assistant = await openai.beta.assistants.create({
  name: 'Code Runner',
  instructions: 'You can run Python code using the run_code tool.',
  model: 'openai/gpt-6.1-sol',
});
// Server-side tools (`tools` on the server) are available to every run without
// being declared on the assistant. Declare `function` tools only for functions
// your client executes (they surface as `requires_action`).
```

### File Upload

```typescript
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

await openai.files.del(file.id);
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
