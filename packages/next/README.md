# @cogitator-ai/next

Next.js App Router integration for Cogitator AI runtime. Provides streaming chat handlers and React hooks compatible with the Vercel AI SDK protocol.

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
  backend: { type: 'openai', apiKey: process.env.OPENAI_API_KEY! },
});

const agent = new Agent({
  name: 'assistant',
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

Creates a streaming chat handler compatible with AI SDK protocol.

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

  // Pre-processing hook
  beforeRun: async (req, input) => {
    console.log('Starting chat with', input.messages.length, 'messages');
    return { userId: 'user-123' }; // Merged into context
  },

  // Post-processing hook
  afterRun: async (result) => {
    console.log('Chat completed:', result.output);
  },
});
```

### `createAgentHandler`

Creates a batch (non-streaming) handler for long-running tasks.

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
  "toolCalls": [...]
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

// Send with metadata (passed to server)
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

The package implements Vercel AI SDK v5 streaming protocol:

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

data: {"type":"finish","messageId":"msg-1","usage":{...}}

data: [DONE]
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

With retry enabled, transient errors (network, 502/503/504) are automatically retried:

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

Stop ongoing requests with the `stop()` function:

```typescript
const { send, stop, isLoading } = useCogitatorChat({ api: '/api/chat' });

// Cancel current request
if (isLoading) {
  stop();
}
```

## License

MIT
