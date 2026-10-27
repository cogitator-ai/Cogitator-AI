# @cogitator-ai/next

Next.js App Router integration for Cogitator AI runtime. Provides streaming chat handlers, a batch agent handler, and React hooks that speak a typed SSE protocol modeled on the Vercel AI SDK event stream.

## Installation

```bash
pnpm add @cogitator-ai/next @cogitator-ai/core
```

Works with Next.js 14, 15 and 16 and React 18 and 19.

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
- uses the **last user message** as the run input, conversation history is carried by `threadId` (configure `memory` on the `Cogitator` instance). Without one the handler opens a new thread and names it in the `start` event, and the `finish` event repeats it, and `useCogitatorChat` adopts it automatically
- passes request `metadata` to the run as `context`, only the keys `acceptContext` allows: the run sends `context` to the model as data the application supplied, so by default a request with `metadata` is refused with `400`
- writes a `: keep-alive` comment every `sseHeartbeatMs` (5 s by default, `0` turns it off) while the run is silent, so a proxy or the platform does not close a stream that waits on a slow tool
- aborts the run when the client disconnects (`req.signal`), unless `resumableStreams` is on (see [Resumable streams](#resumable-streams))
- reads only JSON bodies (`415` for `text/plain` and forms, which browsers send across origins without a preflight), validates the body (JSON object, `messages` array, non-blank `threadId`, object `metadata`, a `multitaskStrategy` of `enqueue`, `reject`, `interrupt` or `rollback`), limits it to 1 MB (413 otherwise) and returns `400` when there is no user message

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

### Resumable streams

With `resumableStreams`, a run outlives a dropped connection and the client picks its stream up where it stopped. `useCogitatorChat` does the client side by itself:

```typescript
// app/api/chat/route.ts
const handler = createChatHandler(cogitator, agent, {
  beforeRun: async (req) => ({ userId: await userIdFrom(req) }),
  resumableStreams: { owner: (req) => (req ? userIdFrom(req) : undefined) },
});
export const POST = handler;
export const DELETE = handler;

// app/api/chat/resume/route.ts
const resume = createResumeHandler(cogitator, agent, {
  stream: true,
  beforeRun: async (req) => ({ userId: await userIdFrom(req) }),
  resumableStreams: { owner: (req) => (req ? userIdFrom(req) : undefined) },
});
export const POST = resume;
export const DELETE = resume;
```

- Every event carries an SSE `id`, `<streamId>:<seq>`, and a client that disconnects no longer stops the run (the `signal` `beforeRun` returns still does).
- The same request again with `Last-Event-ID: <id>` reconnects instead of starting a run: the answer replays the events after the id, then follows the run to `finish` or `error`. `?lastEventId=<id>` works too, but it puts the id into URLs and logs, so prefer the header.
- `DELETE` on the same route with `?streamId=<streamId>` cancels the run (`204`): its stream ends with `STREAM_CANCELLED`. `useCogitatorChat` sends it on `stop()`, `reload()` and every other interrupt, so a stopped answer does not go on spending tokens.
- A reconnect and a cancel read no body and run neither `beforeRun` nor `deps`, whose side effects would repeat. The stream is bound to `owner(req)`: only a request with the same owner may reconnect or cancel, after `authorizeThread(req, threadId)` on the stream's thread (`403 THREAD_FORBIDDEN`). With `beforeRun`, `owner` is required and the handler throws without it. Without `beforeRun` every caller is anonymous. Anyone else, an unknown or expired stream get `404 STREAM_NOT_FOUND`, a malformed id `400 INVALID_INPUT`.
- A reconnect after events that are no longer kept (more than `maxEvents` since) gets one `error` event with `STREAM_RESUME_GAP`. A run nobody follows for `detachedTimeoutMs` (5 minutes) is stopped, so is every run when `until` aborts, and such a stream ends with `STREAM_ABORTED`. A new stream while `maxStreams` streams all go on is refused with `503 STREAM_LIMIT_REACHED`.
- `true` keeps the events in the memory of the handler: 1000 events of each stream, a finished stream for 5 minutes, 1000 streams (`{ maxEvents, retentionMs, maxStreams, detachedTimeoutMs }` to change them). On a serverless platform or several instances, a reconnect or a cancel may reach an instance that did not start the run: pass a `store` they share (`StreamReplayStore` from `@cogitator-ai/server-shared`, backed by Redis or similar with pub/sub), and run where a function may outlive its request.

### `createAgentHandler`

Creates a batch (non-streaming) handler for long-running tasks. The default parser is the validator every Cogitator adapter shares: a non-blank string `input`, an optional object `context` with only the keys `acceptContext` allows (none by default, since the model reads `context` as data the application supplied), an optional non-blank `threadId` and an optional `multitaskStrategy` (`400 { error: { message, code: 'INVALID_INPUT' } }` otherwise, `415` for a body that is not JSON). A `parseInput` of your own decides for itself. The run is aborted if the client disconnects.

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
  "toolCalls": [{ "id": "call_1", "name": "search", "arguments": { "q": "AI" } }],
  "status": "completed",
  "traceId": "trace-xyz"
}
```

The answer is the same object every Cogitator adapter returns (`toAgentRunResponse()` of `@cogitator-ai/server-shared`): `reasoning`, `structured`, `structuredError`, `truncated`, `blocked` and `iterationLimitReached` appear when they apply. It never carries the system prompt, the history or trace spans, whose attributes hold raw tool arguments and errors: `traceId` links the answer to your traces, and `afterRun` receives the whole `RunResult`. A run waiting for [approvals](#approvals) answers `"status": "paused"` with its `pendingApprovals`. A run that fails with a `CogitatorError` answers `{ "error": { "message": message, "code": code } }` with that error's status (for example `429 LLM_RATE_LIMITED`) and a `Retry-After` header when the provider said when to try again. Any other error is logged on the server and answered as `500 { "error": { "message": "Internal server error", "code": "INTERNAL_ERROR" } }`, so its text (connection strings, file paths) never reaches the client. Every Cogitator adapter answers errors in this envelope. The same applies when `afterRun` throws.

### Multiple users

When several people share a server, return the caller's `userId` from `beforeRun`. It reaches `cogitator.run`, which keeps every `threadId` to the user whose run created it:

```typescript
export const POST = createChatHandler(cogitator, agent, {
  beforeRun: async (req) => {
    const user = await getSession(req);
    if (!user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
    return { userId: user.id };
  },
});
```

A `threadId` that belongs to another user is refused before the model is called: `createAgentHandler` answers `403` with `code: "THREAD_ACCESS_DENIED"`, and `createChatHandler` ends the stream with an `error` event carrying that code. Without a `userId`, a caller can use only threads that have no owner.

Every handler also takes the options of the server contract the other Cogitator adapters share:

```typescript
export const POST = createChatHandler(cogitator, agent, {
  beforeRun: async (req) => ({ userId: (await getSession(req))?.id }),
  anonymous: 'deny',
  authorizeThread: (req, threadId) => threadId.startsWith(`${tenantOf(req)}:`),
  deps: (req) => ({ db: databaseFor(tenantOf(req)) }),
});
```

- `anonymous: 'deny'` answers `401 UNAUTHORIZED` when `beforeRun` returned no `userId` (the default `'allow'` lets such callers in).
- `authorizeThread(req, threadId)` is asked about the thread a request names before the run starts, and `false` answers `403 THREAD_FORBIDDEN`.
- `deps(req)` gives the run its `deps` (`context.deps` of its tools), never read from the body. A `deps` that `beforeRun` returns wins over it.

### Approvals

A tool with `requiresApproval` pauses the run before it executes. The runtime keeps the run's checkpoint on the server, per thread; clients only see what waits for a decision:

- `createAgentHandler` answers with `"status": "paused"` and `pendingApprovals` (`toolCallId`, `toolName`, `arguments`, `description`, `sideEffects`).
- `createChatHandler` sends `{"type":"approval-required","threadId":"…","approvals":[…]}` right before `finish`.

`createResumeHandler` continues the run. It takes `{ threadId, decisions?, defaultDecision? }`, where a decision is `{ approved: true }` or `{ approved: false, reason? }` by tool call id. Approved calls run, declined ones answer the model with the reason, and calls left undecided pause the run again. Return the caller's `userId` from `beforeRun` as for the other handlers: only the user the run belongs to may resume it.

```typescript
// app/api/chat/resume/route.ts
import { createResumeHandler } from '@cogitator-ai/next';

export const POST = createResumeHandler(cogitator, agent, {
  stream: true,
  beforeRun: async (req) => ({ userId: (await getSession(req)).id }),
});
```

By default it answers like `createAgentHandler`; with `stream: true` it streams the rest of the run like `createChatHandler`, which is what `useCogitatorChat` wants. Another user's run answers `403 THREAD_ACCESS_DENIED`, a thread without a paused run `409 RUN_NOT_PAUSED` (an `error` event when streaming).

On the client, `useCogitatorChat({ api, resumeApi })` exposes `pendingApprovals` and continues the run into a new assistant message:

```tsx
'use client';

import { useCogitatorChat } from '@cogitator-ai/next/client';

export function Chat() {
  const { messages, pendingApprovals, approve, deny, isLoading } = useCogitatorChat({
    api: '/api/chat',
    resumeApi: '/api/chat/resume',
  });

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>{m.content}</p>
      ))}
      {pendingApprovals.length > 0 && (
        <div>
          {pendingApprovals.map((call) => (
            <p key={call.toolCallId}>
              {call.toolName}: {JSON.stringify(call.arguments)}
            </p>
          ))}
          <button disabled={isLoading} onClick={() => approve()}>
            Approve
          </button>
          <button disabled={isLoading} onClick={() => deny('Not approved')}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
```

For one decision per call, use `resume({ decisions: { [toolCallId]: { approved: true } }, defaultDecision: { approved: false } })`.

`approve()` and `deny(reason?)` answer every pending call, `approveAlways()` approves them and saves each one's `suggestedRule` (see [Permissions](https://cogitator.app/docs/tools/permissions#always-allow)). The approvals clear once the resume is accepted, when the server has nothing paused anymore (`409`), or when the user sends a new message instead, which declines the waiting calls on the server. A JSON `resumeApi` works too: its answer is appended as one assistant message. `useCogitatorAgent({ api, resumeApi })` exposes `pendingApprovals` of the last result and `resume(decisions)`.

A tool can also ask the user a question with `context.interrupt()`, which pauses the run the same way. `createAgentHandler` then answers with `interrupts` (`id`, `kind`, `reason`, `message`, `responseSchema`, `expiresAt`, `toolCallId`, `toolName`), and `createChatHandler` sends `{"type":"interrupt-required","threadId":"…","interrupts":[…]}` instead of `approval-required`. `createResumeHandler` takes the answers by interrupt id in `responses`, and both hooks expose the questions as `pendingInterrupts` and send the answers with `resume({ responses: { [id]: answer } })`. `useCogitatorChat` also calls `onInterruptRequired`. An answer that does not match its `responseSchema` is refused with `400 INTERRUPT_ANSWER_INVALID`, and one sent after `expiresAt` with `410 INTERRUPT_EXPIRED` (a streaming `createResumeHandler` sends both as an `error` event with that `code`).

A run that names a thread may also name a `multitaskStrategy` for when the thread already has a run going on in this Cogitator: `enqueue` waits for that run, `reject` refuses the new run with `THREAD_BUSY`, `interrupt` stops the running one (it fails with `RUN_INTERRUPTED`) and `rollback` stops it and branches from where it started. `createAgentHandler` reads it from the body as `multitaskStrategy` and answers both codes with `409`. `createChatHandler` reads it too, but its stream has already answered `200` and sent `start` when the run meets the other runs of the thread, so it sends them as an `error` event with that `code`. Without one the Cogitator's `multitaskStrategy` applies.

`useCogitatorChat({ multitaskStrategy })` sends it with every message. Without one, `send` aborts the request that is streaming first, as it always did. With `interrupt` or `rollback` it keeps that request open and lets the server stop its run: the old answer stays as far as it got and the hook ignores whatever else its stream sends, including the `RUN_INTERRUPTED` error, since closing the connection itself would abort the run before the server sees the new message and `rollback` would lose the point to branch from. The old request is aborted once the new one is done, or right away when the new one fails (a `403` for instance), so its run never goes on unseen. With `enqueue` or `reject` it leaves that request alone and lets the server decide: an enqueued answer streams in after the running one, and a rejected message ends up in `error` and `onError` while the running answer goes on. `isLoading` stays `true` until every request is done, and `stop` stops them all, the ones handed over to the server included.

On a new conversation the server picks the thread and names it in `start`. A message sent under a strategy before the request ahead of it has named its thread waits for that `start`, so the messages share one thread instead of starting one each (a request that ends without naming one lets the next message start a thread of its own). Approvals and questions belong to the request that paused: when a later message runs on the thread, the server gives up the paused run, so `pendingApprovals` and `pendingInterrupts` clear once that message finishes, or show its own pause instead. A rejected message never ran, so the pause before it stays.

### Triggers and inbox (experimental)

`createTriggerHandler` and `createInboxHandler` serve the routes of API triggers, webhooks and the inbox of their results from the runtime's trigger manager. Start the manager yourself.

```typescript
// lib/cogitator.ts
export const cog = new Cogitator({ experimental_triggers: { agents, routines } });
await cog.experimental_triggers?.start();
export const inbox = createInboxHandler(cog.experimental_triggers!, {
  auth: async (req) => ({ userId: await userIdOf(req) }),
});

// app/api/triggers/[id]/[route]/route.ts
export const POST = createTriggerHandler(cog.experimental_triggers!);

// app/api/inbox/route.ts
export const { GET } = inbox;

// app/api/inbox/[id]/route.ts
export const { PATCH } = inbox;
```

| Route                            | Auth                                                                      | Body                                                             |
| -------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /api/triggers/:id/fire`    | the trigger's own bearer token                                            | `{ "text": "..." }`, read raw                                    |
| `POST /api/triggers/:id/webhook` | the sender's signature (HMAC, GitHub, Mailgun, Postmark, SendGrid, Slack) | any content type, read raw                                       |
| `GET /api/inbox`                 | `auth` and `anonymous`                                                    | `?status=unread&kind=failure&routineId=...&limit=20&before=<ms>` |
| `PATCH /api/inbox/:id`           | `auth` and `anonymous`                                                    | `{ "status": "read" \| "unread" \| "archived" }`                 |

The trigger handler authenticates nothing itself: a trigger checks the token or the signature over the body exactly as it came, read raw for any content type (JSON, forms, multipart) up to 10 MiB and never parsed or re-serialized. A larger body answers `413 PAYLOAD_TOO_LARGE`, and a `route` other than `fire` and `webhook` `404`. It answers with the status, JSON body and headers of the trigger manager, `{ error: { code, message } }` on a refusal. The inbox handlers take the caller from `auth` (`{ userId }`, `undefined` for an anonymous caller). A caller without a user id, which is every caller without `auth`, gets `401 UNAUTHORIZED` unless `anonymous: 'allow'` is set, then they see the items without one. A caller sees and changes only the items of its `userId`, and another user's item answers `404 NOT_FOUND`. `params` may be a promise (Next 15 and later) or the object itself.

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

  // Approvals (see "Approvals")
  pendingApprovals, // PendingApproval[]
  pendingInterrupts, // PendingInterrupt[], the questions the run's tools asked
  resume, // (decisions: ResumeDecisions) => Promise<void>, answers go in `responses`
  approve, // () => Promise<void>
  deny, // (reason?: string) => Promise<void>
} = useCogitatorChat({
  api: '/api/chat',
  threadId: 'optional-thread-id',
  initialMessages: [],
  headers: { 'X-Custom-Header': 'value' },

  // Callbacks
  onError: (error) => console.error(error),
  onFinish: (message) => console.log('Done:', message),
  onToolCall: (toolCall) => console.log('Tool called:', toolCall.name),
  onToolResult: (result) => console.log('Tool result:', result.result, result.presentation),
  onToolCallDropped: (toolCallId) => console.log('Never ran:', toolCallId), // removed from the message
  onReasoning: (delta) => console.log('Thinking:', delta),
  onApprovalRequired: (approvals) => console.log('Waiting for approval:', approvals),
  onInterruptRequired: (interrupts) => console.log('Waiting for answers:', interrupts),

  // Endpoint of a createResumeHandler, for resume/approve/deny
  resumeApi: '/api/chat/resume',

  // Sent with every message, for a thread that already has a run going on
  multitaskStrategy: 'enqueue',

  // Retry configuration
  retry: {
    maxRetries: 3,
    delay: 1000,
    backoff: 'exponential', // 1s, 2s, 4s
  },

  // Resume a stream that drops mid-run (default, false turns it off)
  reconnect: { attempts: 3, delayMs: 1000 },
});
```

#### Reconnecting

Against a handler with `resumableStreams`, whose events carry ids, the hook keeps the id of the last event it got. When the stream drops in the middle of a run (the network fails, or the body ends before `finish` or `error`), it sends the same request again with `Last-Event-ID` and the assistant message goes on in place, with no event lost or repeated. It waits `delayMs` before the first reconnect and twice as long before each next one, and gives up after `attempts` reconnects in a row that failed or brought no event, with the last error (a stream that keeps ending before `finish` gives up with `The stream ended before the run finished`, never a cut answer as if it were done). `STREAM_NOT_FOUND` (the server no longer keeps the stream) and `STREAM_RESUME_GAP` (it lost events after the id) end the request with that error: call `setMessages` with the thread from your own thread route to catch up. `stop()`, `reload()` and a new message that interrupts the current one also cancel its run on the server (`DELETE` with `?streamId=`). A stream without ids ends as before.

#### Sending with Metadata

```typescript
// Basic send
await send('Hello!');

// Send with metadata (passed to the run as `context` on the server,
// for the keys the handler accepts: createChatHandler(cogitator, agent, { acceptContext: ['priority'] }))
await send('Analyze this', {
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
  reasoning, // string | undefined — result?.reasoning
  pendingApprovals, // PendingApproval[] — result?.pendingApprovals
  resume, // (decisions: ResumeDecisions) => Promise<void>
  isLoading, // boolean
  error, // Error | null
  reset, // () => void
} = useCogitatorAgent({
  api: '/api/research',
  resumeApi: '/api/research/resume',
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
data: {"type":"start","messageId":"msg-1","threadId":"thread-abc"}

data: {"type":"text-start","id":"text-1"}

data: {"type":"text-delta","id":"text-1","delta":"Hello"}

data: {"type":"text-delta","id":"text-1","delta":" world"}

data: {"type":"text-end","id":"text-1"}

data: {"type":"tool-call-start","id":"tool-1","toolName":"get_weather"}

data: {"type":"tool-call-delta","id":"tool-1","argsTextDelta":"{\"location\":\"NYC\"}"}

data: {"type":"tool-call-end","id":"tool-1"}

data: {"type":"tool-result","id":"tr-1","toolCallId":"tool-1","result":"72°F"}

data: {"type":"finish","messageId":"msg-1","usage":{...},"threadId":"thread-abc","status":"completed"}

data: [DONE]
```

An agent with `reasoning: { summary: true }` also streams its reasoning summary as `reasoning-start`, `reasoning-delta` and `reasoning-end` events. A text or reasoning block opens with its first delta and is closed before a block of the other kind, a tool call or `finish`, so blocks never overlap. `useCogitatorChat` collects the deltas into `message.reasoning` (and calls `onReasoning` with each one), and `createAgentHandler` returns the summary as `reasoning` next to `usage.reasoningTokens`, `usage.cachedInputTokens` and `usage.cacheWriteTokens` when the provider reports them. The `finish` event of `createChatHandler` carries the same `usage`, these counts included.

A run that pauses for [approvals](#approvals) sends `{"type":"approval-required","threadId":"…","approvals":[…]}` after the open block is closed and before `finish`, and one that pauses for questions its tools asked sends `{"type":"interrupt-required","threadId":"…","interrupts":[…]}` in its place.

If the run fails, the open text or reasoning block is closed and an `{"type":"error","message":"...","code":"..."}` event is sent instead of `finish`. A `CogitatorError` keeps its message and code; any other error is logged on the server and sent as `"message":"Internal server error","code":"INTERNAL_ERROR"`.

The protocol is the one every Cogitator adapter speaks, from `@cogitator-ai/server-shared`. The server-side building blocks are exported for custom handlers:

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
  reasoning?: string; // reasoning summary of an assistant message
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
    reasoningTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  reasoning?: string;
  status: 'completed' | 'paused';
  pendingApprovals?: PendingApproval[];
  structured?: unknown;
  structuredError?: string;
  truncated?: true;
  blocked?: 'content_filter' | 'refusal';
  iterationLimitReached?: true;
  traceId: string;
}

interface PendingApproval {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description: string;
  sideEffects?: string[];
}

interface ResumeDecisions {
  decisions?: Record<string, { approved: true } | { approved: false; reason?: string }>;
  defaultDecision?: { approved: true } | { approved: false; reason?: string };
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

HTTP failures are thrown as `HttpError` (exported from `@cogitator-ai/next/client`) with a `status` property and a message like `Request failed: 400 - No user message provided`. Stream-level `error` events call `onError` with the event's `message` and skip `onFinish`.

On the server, a `beforeRun` that throws an error with a client error `status` (`400` to `499`) answers with that status, its message and its `code` (default `UNAUTHORIZED` for a `401`), and a `CogitatorError` answers as a failed run. Any other error is logged and answered `401 Unauthorized` without its text, so a session store that is down never shows its address. A `parseInput` that throws answers `400 INVALID_INPUT`. Run failures follow the rule above: a `CogitatorError` keeps its message and `code`, anything else becomes `Internal server error` with `code: "INTERNAL_ERROR"`.

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

## Documentation

Full guide: [cogitator.app/docs/integrations/nextjs](https://cogitator.app/docs/integrations/nextjs)

## License

MIT
