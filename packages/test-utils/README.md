# @cogitator-ai/test-utils

Testing utilities for Cogitator to test your own agents, tools, workflows, and backends without calling real LLMs or databases.

## Installation

```bash
pnpm add -D @cogitator-ai/test-utils
```

`@cogitator-ai/test-utils` gives you deterministic stand-ins and helpers to test your own agents and applications without network calls, paid API keys, or external databases. See [Test Utilities](https://cogitator.app/docs/testing/test-utils) on the website.

## Features

- **Mock LLM Backend** - Scriptable `MockLLMBackend` for deterministic `chat()` responses and `chatStream()` chunks with request recording and inspection
- **Mock Memory Adapter** - In-process `MockMemoryAdapter` recording method calls for threads and entries
- **Test Fixtures** - Preconfigured agents, messages, tool calls, tool results, JSON Schema tools, and run results
- **Stream Helpers** - Drain and collect stream content, chunks, and tool calls, or create mock byte streams
- **Async Utilities** - Polling (`waitFor`, `eventually`), delay, and promise timeout helpers
- **Backend Conformance Kit** - Test custom backends against wire protocols (OpenAI, Anthropic, Gemini, Ollama, Bedrock) with `startFakeProvider`
- **Memory Conformance Suites** - Hold memory adapters, memory item stores, memory file stores and embedding stores of your own to the contract of the built-in ones

---

## Quick Start

### Testing with MockLLMBackend

A short, valid Vitest example using `MockLLMBackend`:

```typescript
import { describe, it, expect } from 'vitest';
import { MockLLMBackend, createToolCall } from '@cogitator-ai/test-utils';

describe('MockLLMBackend', () => {
  it('returns scripted responses and inspects requests', async () => {
    const backend = new MockLLMBackend();
    backend.setResponses([
      { toolCalls: [createToolCall('get_weather', { city: 'Tokyo' })] },
      { content: 'The weather in Tokyo is sunny and 22°C.' },
    ]);

    const first = await backend.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });

    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls?.[0].name).toBe('get_weather');

    const second = await backend.chat({
      model: 'test-model',
      messages: [
        { role: 'user', content: 'What is the weather in Tokyo?' },
        { role: 'assistant', content: 'Checking weather...' },
        {
          role: 'tool',
          content: '{"temperature": 22}',
          toolCallId: first.toolCalls![0].id,
          name: 'get_weather',
        },
      ],
    });

    expect(second.content).toBe('The weather in Tokyo is sunny and 22°C.');
    expect(second.finishReason).toBe('stop');

    expect(backend.getCallCount()).toBe(2);
    expect(backend.wasCalledWith((req) => req.model === 'test-model')).toBe(true);
    expect(backend.getLastCall()?.messages).toHaveLength(3);
  });
});
```

### Testing with MockMemoryAdapter

A short, valid Vitest example using `MockMemoryAdapter`:

```typescript
import { describe, it, expect } from 'vitest';
import { MockMemoryAdapter, createUserMessage } from '@cogitator-ai/test-utils';

describe('MockMemoryAdapter', () => {
  it('stores conversation history and records calls', async () => {
    const memory = new MockMemoryAdapter();
    await memory.connect();
    expect(memory.isConnected()).toBe(true);

    const threadResult = await memory.createThread('agent-1', { topic: 'testing' }, 'thread-123');
    expect(threadResult.success).toBe(true);

    const addResult = await memory.addEntry({
      threadId: 'thread-123',
      message: createUserMessage('Remember this note'),
      tokenCount: 4,
    });
    expect(addResult.success).toBe(true);

    const entriesResult = await memory.getEntries({ threadId: 'thread-123' });
    expect(entriesResult.success).toBe(true);
    if (entriesResult.success) {
      expect(entriesResult.data).toHaveLength(1);
      expect(entriesResult.data[0].message.content).toBe('Remember this note');
    }

    expect(memory.getCallsFor('createThread')).toHaveLength(1);
    expect(memory.getCallsFor('addEntry')).toHaveLength(1);

    await memory.disconnect();
    expect(memory.isConnected()).toBe(false);
  });
});
```

---

## Mocks

### MockLLMBackend

`MockLLMBackend` implements `LLMBackend` (`provider: 'openai'`) and answers calls with scripted responses or stream chunks while recording all incoming requests.

#### Scripting Chat Responses

```typescript
import { MockLLMBackend, createMockLLMBackend, createToolCall } from '@cogitator-ai/test-utils';

const backend = createMockLLMBackend();

// Set a single response for all chat() calls
backend.setResponse({ content: 'Hello, world!' });

// Set multiple responses returned in sequence (the last response repeats)
backend.setResponses([{ content: 'First response' }, { content: 'Second response' }]);

// Shortcut for scripted tool call responses
backend.setToolCallResponse([createToolCall('calculator', { expression: '2 + 2' })]);

// Set default delay (in ms) before answering
backend.setDefaultDelay(50);
```

#### Streaming

```typescript
import { MockLLMBackend, collectStreamContent } from '@cogitator-ai/test-utils';

const backend = new MockLLMBackend();

// Script a stream for chatStream()
backend.setStreamChunks([{ content: 'Hello' }, { content: ' world' }, { content: '!' }]);

// Or script multiple distinct streams in sequence
backend.setMultipleStreamChunks([[{ content: 'First stream' }], [{ content: 'Second stream' }]]);

const stream = backend.chatStream({
  model: 'test-model',
  messages: [{ role: 'user', content: 'Hi' }],
});

const text = await collectStreamContent(stream);
```

#### Request Inspection

```typescript
// Inspect recorded requests
const count = backend.getCallCount();
const allCalls = backend.getCalls();
const lastCall = backend.getLastCall();

// Predicate match
const wasCalled = backend.wasCalledWith((req) => req.model === 'test-model');

// Reset calls, responses, and stream chunks
backend.reset();
```

### MockMemoryAdapter

`MockMemoryAdapter` implements `MemoryAdapter` (`provider: 'memory'`) in memory using native Maps and records every invocation.

```typescript
import { MockMemoryAdapter, createMockMemoryAdapter } from '@cogitator-ai/test-utils';

const memory = createMockMemoryAdapter();

// Lifecycle
await memory.connect();
const connected = memory.isConnected(); // true

// Threads
const thread = await memory.createThread('agent-id', { tag: 'session' }, 'custom-id');
const fetchedThread = await memory.getThread('custom-id');
await memory.updateThread('custom-id', { tag: 'updated' });

// Entries
await memory.addEntry({
  threadId: 'custom-id',
  message: { role: 'user', content: 'Hello' },
  tokenCount: 1,
});
const entries = await memory.getEntries({ threadId: 'custom-id', limit: 10 });
const singleEntry = await memory.getEntry(
  entries.success && entries.data[0] ? entries.data[0].id : ''
);
await memory.deleteEntry('entry-id');
await memory.clearThread('custom-id');
await memory.deleteThread('custom-id');

// Inspection
const calls = memory.getCalls(); // Array<{ method: string; args: unknown[] }>
const threadCalls = memory.getCallsFor('createThread');

// Reset all internal state and calls
memory.reset();
await memory.disconnect();
```

---

## Fixtures

### Agents

Generate test agent configs or agent-shaped objects with test defaults:

```typescript
import { createTestAgentConfig, createTestAgent } from '@cogitator-ai/test-utils';

// AgentConfig with default name 'test-agent' and model 'mock/test-model'
const config = createTestAgentConfig({
  name: 'custom-agent',
  instructions: 'Custom instructions',
});

// Agent-shaped object implementing the Agent interface
const agent = createTestAgent({
  name: 'test-agent',
});
```

### Messages and Tool Calls

Construct strongly typed conversation messages, tool calls, and tool results:

```typescript
import {
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  createToolMessage,
  createMultimodalMessage,
  createImageUrlMessage,
  createToolCall,
  createToolResult,
  createConversation,
} from '@cogitator-ai/test-utils';

const userMsg = createUserMessage('Hello');
const assistantMsg = createAssistantMessage('Hi there');
const systemMsg = createSystemMessage('You are a test assistant');
const toolMsg = createToolMessage('call_1', '{"result": 42}', 'calculator');

const multimodalMsg = createMultimodalMessage([
  { type: 'text', text: 'Describe this' },
  { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
]);
const imgMsg = createImageUrlMessage('Look at this', 'https://example.com/image.png');

const call = createToolCall('calculator', { expression: '2 + 2' });
const result = createToolResult(call, { result: 4 });

const turns = createConversation(
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' }
);
```

### Tools

Predefined JSON Schema tool fixtures for testing tool execution and schema passing:

```typescript
import {
  createTestTool,
  createCalculatorTool,
  createWeatherTool,
  createFailingTool,
  createSlowTool,
  createToolSchema,
} from '@cogitator-ai/test-utils';

// Customizable SimpleTool
const customTool = createTestTool({
  name: 'custom_tool',
  description: 'A custom tool',
  execute: async (args) => ({ echo: args }),
});

// Built-in tools
const calc = createCalculatorTool(); // evaluates arithmetic expressions ('2 + 2')
const weather = createWeatherTool(); // returns 22°C sunny weather for city
const failing = createFailingTool('Custom error'); // always throws
const slow = createSlowTool(50); // delays for specified ms before returning

// ToolSchema fixture
const schema = createToolSchema('my_tool', 'Tool description');
```

### Run Results

Mock `RunResult` structures for code consuming agent execution outcomes:

```typescript
import {
  createMockRunResult,
  createRunResultWithToolCalls,
  createRunResultWithMessages,
} from '@cogitator-ai/test-utils';

const baseResult = createMockRunResult('Final answer');
const withTools = createRunResultWithToolCalls('Output', [call]);
const withHistory = createRunResultWithMessages('Output', [userMsg, assistantMsg]);
```

---

## Helpers

### Stream Helpers

Helpers to consume and test asynchronous generator streams (`AsyncGenerator<ChatStreamChunk>`):

```typescript
import {
  collectStreamContent,
  collectStreamChunks,
  collectStreamToolCalls,
  createMockReadableStream,
} from '@cogitator-ai/test-utils';

// Drains stream and returns concatenated text
const content = await collectStreamContent(stream);

// Drains stream and returns all chunks as an array
const chunks = await collectStreamChunks(stream);

// Drains stream and returns parsed tool calls
const toolCalls = await collectStreamToolCalls(stream);

// Creates a ReadableStream<Uint8Array> from string chunks (e.g. for SSE testing)
const byteStream = createMockReadableStream(['data: {"text":"hello"}\n\n']);
```

### Async Helpers

Utilities for handling asynchronous timing, polling, and timeouts:

```typescript
import { waitFor, eventually, delay, withTimeout } from '@cogitator-ai/test-utils';

// Sleep for ms
await delay(100);

// Poll condition until truthy or timeout (defaults: timeout 5000ms, interval 50ms)
const ready = await waitFor(() => checkReady(), { timeout: 2000, interval: 20 });

// Retry assertion until it passes or timeout
await eventually(() => expect(isDone()).toBe(true), { timeout: 3000, interval: 50 });

// Wrap promise with timeout
const value = await withTimeout(fetchData(), 1000);
```

---

## Conformance

A complete kit for verifying that custom or third-party `LLMBackend` implementations correctly adhere to provider protocols, error handling, cancellation, and streaming conventions.

### Backend Conformance Suite

Run the full suite of conformance test cases against an `LLMBackend`:

```typescript
import { describe, it } from 'vitest';
import {
  backendConformanceCases,
  openAIChatWire,
  type BackendConformanceTarget,
} from '@cogitator-ai/test-utils';

const target: BackendConformanceTarget = {
  name: 'MyCustomBackend',
  model: 'gpt-4o',
  wire: openAIChatWire,
  createBackend: (url) => new MyCustomBackend({ baseUrl: url }),
};

describe('MyCustomBackend conformance', () => {
  for (const c of backendConformanceCases(target)) {
    (c.skip ? it.skip : it)(c.name, () => c.run());
  }
});
```

### Fake Provider Server

Run a lightweight HTTP server emulating provider APIs:

```typescript
import { startFakeProvider, sse } from '@cogitator-ai/test-utils';

const server = await startFakeProvider();

server.reply((req) => {
  if (req.path === '/v1/chat/completions') {
    return {
      type: 'stream',
      contentType: 'text/event-stream',
      chunks: [sse({ choices: [{ delta: { content: 'Hi' } }] })],
    };
  }
  return { type: 'json', status: 404, body: { error: 'Not found' } };
});

console.log(`Fake provider listening at: ${server.url}`);

await server.close();
```

### Wire Protocols & Encodings

Wire specifications and formatting helpers for popular LLM provider protocols:

- **Wires**: `openAIChatWire`, `openAIResponsesWire`, `anthropicWire`, `geminiWire`, `ollamaWire`, `bedrockConverseWire`
- **Encodings**: `sse(data, event?)`, `ndjson(data)`, `awsEventStreamMessage(headers, payload)`
- **Fixture**: `conformanceRequest`, `CONFORMANCE_FIXTURE`

### Memory adapters and embedding stores

`memoryAdapterConformanceCases(target)`, `memoryItemAdapterConformanceCases(target)`, `memoryFileAdapterConformanceCases(target)` and `embeddingAdapterConformanceCases(target)` check a `MemoryAdapter`, a `MemoryItemAdapter`, a `MemoryFileAdapter` or an `EmbeddingAdapter` against the contract the built-in ones keep: missing versus `null`, atomic `updateThread`, entry order with equal timestamps, limits, cascades, copies, `listThreads` filters and paging, nearest-first search, thresholds, filters and deletes.

```typescript
for (const c of memoryAdapterConformanceCases({
  create: async () => {
    const adapter = new MyAdapter();
    await adapter.connect();
    return adapter;
  },
  release: (adapter) => adapter.disconnect().then(() => undefined),
})) {
  (c.skip ? it.skip : it)(c.name, () => c.run());
}
```

Each case uses threads, agents or embeddings of its own, so one database can serve them all. The embedding suite also takes `dimensions`. In the memory file suite `file-find-heads` checks `findFileHeads`: the newest version of each scope and path, deletions included, a version placed off the branch left out, oldest first, and nothing for an adapter without it. In the memory adapter suite `redacts-an-entry-in-place` checks `redactEntry`: a redacted entry keeps its place, role and tool call ids, keeps nothing of what it said in its text, tool arguments or tool results, records `metadata.redacted`, gives `null` when missing and is reported once as `entry-redacted`, and, on an adapter with branches, that it keeps its parent (also once the parent is deleted) and that an event entry is refused (nothing is checked for an adapter without `redactEntry` or `onChange`). The memory item suite checks that items and entities read back field for field (dates as `Date`s, a missing field absent, never `null`), replace by id, `findItems` filters, scope filters (`visibleTo`, `scope`) and order (oldest recorded first), items let go left out unless `includeExpired` while one let go later is still found, entities found by any normalized name, deletes and copies. The memory file suite checks that a version of a memory file reads back field for field (a deletion's `null` content included), that a version in a place another one holds (scope, path and `sequence`) is refused with `MEMORY_FILE_CONFLICT`, also when writers race for one place, that a refused batch keeps none of its versions, the filters (`ids`, `paths`, `prefix`, `visibleTo`, `scope`) and their order (by `createdAt`, then `sequence`, then id), redaction (content and `sha256` replaced, nothing else changed), deletes and copies.

---

## Public Exports

Public exports are grouped in `src/index.ts` as:

| Group           | Module                                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mocks**       | `@cogitator-ai/test-utils` (`./mocks`)       | `MockLLMBackend`, `createMockLLMBackend`, `MockMemoryAdapter`, `createMockMemoryAdapter`, `MockChatResponse`, `MockStreamChunk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Fixtures**    | `@cogitator-ai/test-utils` (`./fixtures`)    | `createTestAgent`, `createTestAgentConfig`, `TestAgentConfig`, `createUserMessage`, `createAssistantMessage`, `createSystemMessage`, `createToolMessage`, `createMultimodalMessage`, `createImageUrlMessage`, `createToolCall`, `createToolResult`, `createConversation`, `createTestTool`, `createCalculatorTool`, `createWeatherTool`, `createFailingTool`, `createSlowTool`, `createToolSchema`, `TestToolOptions`, `SimpleTool`, `createMockRunResult`, `createRunResultWithToolCalls`, `createRunResultWithMessages`, `TestRunResultOptions`                                                                                                                                                    |
| **Helpers**     | `@cogitator-ai/test-utils` (`./helpers`)     | `collectStreamContent`, `collectStreamChunks`, `collectStreamToolCalls`, `createMockReadableStream`, `waitFor`, `eventually`, `delay`, `withTimeout`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Conformance** | `@cogitator-ai/test-utils` (`./conformance`) | `startFakeProvider`, `FakeProvider`, `FakeProviderHandler`, `FakeProviderOptions`, `FakeProviderReply`, `FakeProviderRequest`, `backendConformanceCases`, `conformanceRequest`, `CONFORMANCE_FIXTURE`, `BackendConformanceCase`, `BackendConformanceTarget`, `ConformanceMode`, `ConformanceScenario`, `ProviderWire`, `openAIChatWire`, `openAIResponsesWire`, `anthropicWire`, `geminiWire`, `ollamaWire`, `bedrockConverseWire`, `sse`, `ndjson`, `awsEventStreamMessage`, `memoryAdapterConformanceCases`, `memoryItemAdapterConformanceCases`, `memoryFileAdapterConformanceCases`, `embeddingAdapterConformanceCases` and their `*ConformanceCase`, `*ConformanceTarget` and `*Scenario` types |

---

## License

MIT
