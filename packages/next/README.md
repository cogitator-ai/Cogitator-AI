# @cogitator-ai/next

Next.js App Router integration for Cogitator AI runtime. Provides streaming chat handlers, a batch agent handler, and React hooks that speak a typed SSE protocol modeled on the Vercel AI SDK event stream.

## Installation

```bash
pnpm add @cogitator-ai/next @cogitator-ai/core
```

## Quick Start

### 1. Create API Route

```typescript
// app/api/chat/route.ts
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { createChatHandler } from '@cogitator-ai/next';
import { z } from 'zod';

const cogitator = new Cogitator({
  llm: {
    defaultModel: 'openai/gpt-6-luna',
    providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  },
});

const agent = new Agent({
  name: 'assistant',
  model: 'openai/gpt-6-luna',
  instructions: 'You are a helpful assistant.',
  tools: [
    tool({
      name: 'get_weather',
      description: 'Get weather for a location',
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }) => `Weather in ${location}: 72°F, sunny`,
    }),
  ],
});

export const POST = createChatHandler(cogitator, agent);
```

### 2. Use in Client Component

```tsx
'use client';

import { useCogitatorChat } from '@cogitator-ai/next/client';

export function Chat() {
  const { messages, input, setInput, send, isLoading } = useCogitatorChat({
    api: '/api/chat',
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading}>
          Send
        </button>
      </form>
    </div>
  );
}
```

## Server Handlers

### `createChatHandler`

Creates a streaming chat handler. The handler:

- runs the agent with token streaming enabled and forwards `text-*`, `tool-*` and `finish` events as they happen
- uses the **last user message** as the run input; conversation history is carried by `threadId` (configure `memory` on the `Cogitator` instance) — the server returns the thread id in the `finish` event and `useCogitatorChat` adopts it automatically
- passes request `metadata` to the run as `context`
- aborts the run when the client disconnects (`req.signal`)
- validates the body (JSON object, `messages` array, string `threadId`, object `metadata`), limits it to 1 MB (413 otherwise) and returns `400` when there is no user message

```typescript
import { createChatHandler } from '@cogitator-ai/next';

export const POST = createChatHandler(cogitator, agent, {
  // Custom input parsing
  parseInput: async (req) => {
    const body = await req.json();
    return {
      messages: body.messages,
      threadId: body.threadId,
      metadata: body.metadata,
    };
  },

  // Pre-processing hook — the returned object is merged into the run options
  // (e.g. userId, threadId, timeout). Streaming callbacks and the abort
  // signal are always managed by the handler. Throw an error with a `status`
  // property to reject the request with that status (default 401).
  beforeRun: async (req, input) => {
    console.log('Starting chat with', input.messages.length, 'messages');
    return { userId: 'user-123' };
  },

  // Post-processing hook — runs before the `finish` event; if it throws,
  // the client receives an `error` event instead of `finish`
  afterRun: async (result) => {
    console.log('Chat completed:', result.output);
  },
});
```

### `createAgentHandler`

Creates a batch (non-streaming) handler for long-running tasks. The default parser requires a non-blank string `input`, an optional object `context` and an optional string `threadId` (400 otherwise). The run is aborted if the client disconnects.

```typescript
import { createAgentHandler } from '@cogitator-ai/next';

export const POST = createAgentHandler(cogitator, researchAgent, {
  parseInput: async (req) => {
    const body = await req.json();
    return {
      input: body.query,
      context: body.context,
      threadId: body.threadId,
    };
  },
});
```

Response format:

```json
{
  "output": "Research results...",
  "threadId": "thread-abc",
  "usage": {
    "inputTokens": 150,
    "outputTokens": 500,
    "totalTokens": 650
  },
  "toolCalls": [...],
  "trace": { "traceId": "trace-xyz", "spans": [...] }
}
```

## Client Hooks

### `useCogitatorChat`

Full-featured chat hook with streaming support.

```typescript
const {
  // State
  messages, // ChatMessage[]
  input, // string
  isLoading, // boolean
  error, // Error | null
  threadId, // string | undefined

  // Actions
  setInput, // (value: string) => void
  send, // (input?: string, metadata?: Record<string, unknown>) => Promise<void>
  stop, // () => void
  reload, // () => Promise<void>
  setThreadId, // (id: string) => void

  // Message management
  appendMessage, // (message: ChatMessage) => void
  clearMessages, // () => void
  setMessages, // (messages: ChatMessage[]) => void
} = useCogitatorChat({
  api: '/api/chat',
  threadId: 'optional-thread-id',
  initialMessages: [],
  headers: { 'X-Custom-Header': 'value' },

  // Callbacks
  onError: (error) => console.error(error),
  onFinish: (message) => console.log('Done:', message),
  onToolCall: (toolCall) => console.log('Tool called:', toolCall.name),
  onToolResult: (result) => console.log('Tool result:', result),

  // Retry configuration
  retry: {
    maxRetries: 3,
    delay: 1000,
    backoff: 'exponential', // 1s, 2s, 4s
  },
});
```

#### Sending with Metadata

```typescript
// Basic send
await send('Hello!');

// Send with metadata (passed to the run as `context` on the server)
await send('Analyze this', {
  userId: 'user-123',
  priority: 'high',
});

// Send using input state
setInput('My message');
await send();
```

#### Message Management

```typescript
// Add a system message
appendMessage({
  id: crypto.randomUUID(),
  role: 'system',
  content: 'Context updated.',
});

// Clear conversation
clearMessages();

// Replace all messages
setMessages([{ id: '1', role: 'user', content: 'New conversation' }]);
```

### `useCogitatorAgent`

Hook for non-streaming batch requests (research, analysis, etc).

```typescript
const {
  run, // (input: AgentInput) => Promise<void>
  result, // AgentResponse | null
  isLoading, // boolean
  error, // Error | null
  reset, // () => void
} = useCogitatorAgent({
  api: '/api/research',
  headers: { Authorization: 'Bearer token' },

  onError: (error) => console.error(error),
  onSuccess: (result) => console.log('Done:', result.output),

  retry: {
    maxRetries: 2,
    delay: 2000,
    backoff: 'linear',
  },
});

// Execute
await run({
  input: 'Research AI trends in 2025',
  context: { focus: 'enterprise' },
  threadId: 'research-session-1',
});

// Access result
console.log(result?.output);
console.log(result?.toolCalls);
```

## Streaming Protocol

The chat handler streams Server-Sent Events. The event names follow the Vercel AI SDK event-stream style, but the payloads are Cogitator's own (`tool-call-*`, `message` on errors, `usage`/`threadId` on finish), so use `useCogitatorChat` (or your own parser) on the client rather than the AI SDK's `useChat`:

```
data: {"type":"start","messageId":"msg-1"}

data: {"type":"text-start","id":"text-1"}

data: {"type":"text-delta","id":"text-1","delta":"Hello"}

data: {"type":"text-delta","id":"text-1","delta":" world"}

data: {"type":"text-end","id":"text-1"}

data: {"type":"tool-call-start","id":"tool-1","toolName":"get_weather"}

data: {"type":"tool-call-delta","id":"tool-1","argsTextDelta":"{\"location\":\"NYC\"}"}

data: {"type":"tool-call-end","id":"tool-1"}

data: {"type":"tool-result","id":"tr-1","toolCallId":"tool-1","result":"72°F"}

data: {"type":"finish","messageId":"msg-1","usage":{...},"threadId":"thread-abc"}

data: [DONE]
```

If the run fails, the open text block is closed and an `{"type":"error","message":"..."}` event is sent instead of `finish`.

The server-side building blocks are exported for custom handlers:

```typescript
import { StreamWriter, encodeSSE, generateId } from '@cogitator-ai/next';
import type { StreamEvent, Usage } from '@cogitator-ai/next';
```

## Types

```typescript
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

interface AgentInput {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
}

interface AgentResponse {
  output: string;
  threadId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCalls: ToolCall[];
  trace?: { traceId: string; spans: unknown[] };
}

interface RetryConfig {
  maxRetries?: number; // default: 0
  delay?: number; // default: 1000ms
  backoff?: 'linear' | 'exponential';
}
```

## Error Handling

Both hooks provide error state and callbacks:

```typescript
const { error, isLoading } = useCogitatorChat({
  api: '/api/chat',
  onError: (err) => {
    toast.error(err.message);
  },
});

if (error) {
  return <div>Error: {error.message}</div>;
}
```

HTTP failures are thrown as `HttpError` (exported from `@cogitator-ai/next/client`) with a `status` property and a message like `Request failed: 400 - No user message provided`. Stream-level `error` events call `onError` and skip `onFinish`.

With retry enabled, transient errors (network failures, 408/429/502/503/504) are automatically retried; the backoff wait is cancelled by `stop()`:

```typescript
useCogitatorChat({
  api: '/api/chat',
  retry: {
    maxRetries: 3,
    delay: 1000,
    backoff: 'exponential',
  },
});
```

## Cancellation

Stop ongoing requests with the `stop()` function. The partial assistant message is kept in `messages`, and the server aborts the agent run when the connection closes. Calling `send()` while a response is streaming interrupts it the same way. Pending requests are aborted when the component unmounts; `useCogitatorAgent` aborts a previous `run()` when a new one starts and on `reset()`.

```typescript
const { send, stop, isLoading } = useCogitatorChat({ api: '/api/chat' });

// Cancel current request
if (isLoading) {
  stop();
}
```

## License

MIT
