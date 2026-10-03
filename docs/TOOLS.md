# Tools

> Building, using, and managing agent capabilities

## Overview

Tools give agents the ability to interact with the outside world. In Cogitator, tools are:

- **Type-safe** — Parameters validated with Zod schemas
- **Sandboxable** — Optionally run in Docker or WASM isolation
- **MCP-compatible** — Consume tools from MCP servers or expose your own
- **Observable** — Every call is traced as a `tool.<name>` span

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Tool System                             │
│                                                                      │
│   Built-in Tools  │  Custom Tools  │  MCP Tools  │  WASM Tools       │
│                                                                      │
│                                   │                                  │
│                                   ▼                                  │
│      validation (Zod) → approval → guardrails → execution            │
│                                                                      │
│        ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│        │   Native    │   │   Docker    │   │    WASM     │           │
│        │ (execute()) │   │   Sandbox   │   │   Sandbox   │           │
│        └─────────────┘   └─────────────┘   └─────────────┘           │
└──────────────────────────────────────────────────────────────────────┘
```

More detail on the website: [Tools](https://cogitator.app/docs/core/tools), [Custom Tools](https://cogitator.app/docs/tools/custom-tools), [Built-in Tools](https://cogitator.app/docs/tools/built-in), [Approvals](https://cogitator.app/docs/tools/approvals), [WASM Tools](https://cogitator.app/docs/tools/wasm-tools), [MCP](https://cogitator.app/docs/integrations/mcp).

---

## Creating Tools

### Basic Tool

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name, e.g. "Berlin"'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  execute: async ({ city, units }, context) => {
    const res = await fetch(
      `https://api.example.com/weather?city=${encodeURIComponent(city)}&units=${units}`,
      { signal: context.signal }
    );
    return res.json();
  },
});
```

`execute` receives the validated parameters and a `ToolContext` (`agentId`, `runId`, `signal`, and — when known — `threadId`, `userId`, `channelType`, `channelId`). Other `ToolConfig` fields: `category`, `tags`, `sideEffects`, `requiresApproval`, `timeout` (ms) and `sandbox`.

A parameter with `.default()` is optional in the JSON Schema the model sees, and `execute` gets the default when the model leaves it out (`units` above).

### Returning Images

A result object with a base64 image in `image` or `imageBase64` (PNG, JPEG, GIF or WebP, plain or as a `data:image/...;base64,` URL) reaches the model as an image; the rest of the object is sent as JSON with the image field replaced by `"(image attached)"`:

```typescript
const renderChart = tool({
  name: 'render_chart',
  description: 'Render a line chart of the given values as a PNG',
  parameters: z.object({ values: z.array(z.number()) }),
  execute: async ({ values }) => {
    const png = await drawChart(values);
    return { points: values.length, image: png.toString('base64') };
  },
});
```

Each backend places the image where its API allows: inside the tool result for Anthropic, Bedrock and the OpenAI Responses API, after the function responses of the turn for Google, in the tool message's `images` for Ollama, and in a user message right after the turn's tool messages for Chat Completions (OpenAI-compatible `baseUrl`, Azure). The image-generation tool (`imageBase64`) and the browser screenshot tools (`image`) use this.

### Tool with Complex Schema

```typescript
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const workspaceRoot = '/workspace';

const createFile = tool({
  name: 'create_file',
  description: 'Create a new file with the specified content',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace root'),
    content: z.string().describe('File content'),
    encoding: z.enum(['utf-8', 'base64']).default('utf-8').describe('Content encoding'),
    overwrite: z.boolean().default(false).describe('Whether to overwrite existing file'),
  }),
  execute: async ({ path, content, encoding, overwrite }) => {
    const fullPath = join(workspaceRoot, path);

    const exists = await access(fullPath).then(
      () => true,
      () => false
    );
    if (!overwrite && exists) {
      return { error: `File already exists: ${path}. Set overwrite: true to replace.` };
    }

    const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content);
    await writeFile(fullPath, buffer);

    return { success: true, path, size: buffer.byteLength };
  },
});
```

### Side Effects and Approval

```typescript
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCallback);

const shellExecute = tool({
  name: 'shell_execute',
  description: 'Execute a shell command',
  parameters: z.object({
    command: z.string().describe('Command to execute'),
    cwd: z.string().optional().describe('Working directory'),
  }),

  sideEffects: ['filesystem', 'network', 'process'],

  requiresApproval: (params) => {
    const dangerous = ['rm', 'sudo', 'chmod', 'kill', 'reboot'];
    return dangerous.some((cmd) => params.command.includes(cmd));
  },

  timeout: 30_000,

  execute: async ({ command, cwd }, context) => {
    const { stdout, stderr } = await execAsync(command, { cwd, signal: context.signal });
    return { stdout: stdout.slice(0, 10_000), stderr: stderr.slice(0, 10_000) };
  },
});
```

`sideEffects` accepts `'filesystem' | 'network' | 'database' | 'process' | 'external'`. `requiresApproval` is `true` or a predicate over the call's parameters.

### Tool Sets

A function that builds several related tools can return them with `toolset()`: the result is a plain array an agent accepts, and each element keeps its own parameter and result types.

```typescript
import { tool, toolset } from '@cogitator-ai/core';

function createOrderTools(api: OrdersApi) {
  return toolset(
    tool({
      name: 'find_order',
      description: 'Find an order by id',
      parameters: z.object({ id: z.string() }),
      execute: ({ id }) => api.find(id),
    }),
    tool({
      name: 'cancel_order',
      description: 'Cancel an order',
      parameters: z.object({ id: z.string(), reason: z.string() }),
      execute: ({ id, reason }) => api.cancel(id, reason),
    })
  );
}
```

`createMemoryTools`, `createSchedulerTools` and the browser tool factories return their tools the same way.

---

## Approvals

A tool with `requiresApproval` never runs without a decision. Decide inline with `onApproval`, or let the run **pause**: it returns `status: 'paused'` with `pendingApprovals` and continues with `cog.resume()` once someone decided.

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';

const cog = new Cogitator();
const agent = new Agent({
  name: 'ops',
  model: 'openai/gpt-5.5',
  instructions: 'You operate the build server.',
  tools: [shellExecute],
});

const result = await cog.run(agent, { input: 'Clean the build directory' });

if (result.status === 'paused') {
  for (const call of result.pendingApprovals ?? []) {
    console.log(`${call.toolName}(${JSON.stringify(call.arguments)}) needs approval`);
  }

  const done = await cog.resume(agent, result.threadId, {
    defaultDecision: { approved: true },
  });
  console.log(done.output);
}

await cog.run(agent, {
  input: 'Clean the build directory',
  onApproval: async (call) => (call.toolName === 'shell_execute' ? { approved: true } : 'pause'),
});
```

Paused runs live in the memory adapter's threads (or process memory without one, or a custom `runCheckpoints` store). See [Approvals](https://cogitator.app/docs/tools/approvals).

---

## Built-in Tools

All built-in tools are exported directly from `@cogitator-ai/core`.

### File Operations

```typescript
import { Agent, fileRead, fileWrite, fileDelete, fileList, fileExists } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'file-agent',
  model: 'openai/gpt-5.5',
  instructions: 'You manage files in the workspace.',
  tools: [fileRead, fileWrite, fileList, fileExists, fileDelete],
});
```

### Web Operations

```typescript
import { webSearch, webScrape } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'researcher',
  model: 'openai/gpt-5.5',
  instructions: 'You research topics on the web.',
  tools: [webSearch, webScrape],
});
```

`webSearch` picks Tavily, Brave or Serper from the available API keys (`TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`).

### HTTP & System

```typescript
import { httpRequest, exec, sqlQuery } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'ops',
  model: 'openai/gpt-5.5',
  instructions: 'You call APIs, run commands and query the database.',
  tools: [httpRequest, exec, sqlQuery],
});
```

`exec` requires approval and declares a Docker sandbox (`cogitator/sandbox:base`, no network).

### All Built-in Tools

```typescript
import { Agent, builtinTools } from '@cogitator-ai/core';

const agent = new Agent({
  name: 'generalist',
  model: 'openai/gpt-5.5',
  instructions: 'You are a helpful assistant.',
  tools: builtinTools,
});
```

`builtinTools` is a `Tool[]` and includes: `calculator`, `datetime`, `uuid`, `randomNumber`, `randomString`, `hash`, `base64Encode`, `base64Decode`, `sleep`, `jsonParse`, `jsonStringify`, `regexMatch`, `regexReplace`, `fileRead`, `fileWrite`, `fileList`, `fileExists`, `fileDelete`, `httpRequest`, `exec`, `webSearch`, `webScrape`, `sqlQuery`, `vectorSearch`, `sendEmail`, `githubApi`.

Tool factories that need configuration are exported separately: `createMemoryTools`, `createSchedulerTools`, `createCapabilitiesTool`, `createDeviceTools`, `createSelfTools`, `createAnalyzeImageTool`, `createGenerateImageTool`, `createTranscribeAudioTool`, `createGenerateSpeechTool`. See [Built-in Tools](https://cogitator.app/docs/tools/built-in).

---

## MCP Integration

### Connecting to MCP Servers

```typescript
import { connectMCPServer } from '@cogitator-ai/mcp';

const { tools, cleanup } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

const agent = new Agent({
  name: 'fs-agent',
  model: 'openai/gpt-5.5',
  instructions: 'You work with files through MCP.',
  tools,
});

await cleanup();
```

### Manual Client Usage

```typescript
import { MCPClient } from '@cogitator-ai/mcp';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

const fsTools = await client.getTools();

const remote = await MCPClient.connect({
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` },
});

const remoteTools = await remote.getTools();

const agent = new Agent({
  name: 'mcp-agent',
  model: 'openai/gpt-5.5',
  instructions: 'You use local files and remote MCP tools.',
  tools: [...fsTools, ...remoteTools],
});

await client.close();
await remote.close();
```

The client also exposes `listResources()`, `readResource()`, `listPrompts()`, `getPrompt()` and `callTool()`.

### Serving Tools over MCP

```typescript
import { MCPServer, serveMCPTools } from '@cogitator-ai/mcp';
import { calculator, webSearch } from '@cogitator-ai/core';

const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
  transport: 'stdio',
});
server.registerTool(getWeather);
await server.start();

await serveMCPTools([calculator, webSearch], {
  name: 'cogitator-tools',
  version: '1.0.0',
  transport: 'http',
  port: 3333,
});
```

### Serving Agents over MCP

`serveAgents` turns whole agents into MCP tools (one per agent, plus `<agent>_resume` for agents whose tools need approval):

```typescript
import { serveAgents } from '@cogitator-ai/mcp';

await serveAgents(cog, [agent]);
```

See [MCP](https://cogitator.app/docs/integrations/mcp) for HTTP transport, auth, sessions and elicitation.

---

## Tool Registry

`ToolRegistry` is the lookup table the runtime uses for an agent's tools. You rarely need it directly.

```typescript
import { ToolRegistry, calculator, fileRead, fileWrite, fileList } from '@cogitator-ai/core';

const registry = new ToolRegistry();

registry.register(calculator);
registry.registerMany([fileRead, fileWrite, fileList]);

const allTools = registry.getAll();
const calc = registry.get('calculator');
const exists = registry.has('calculator');
const names = registry.getNames();
const schemas = registry.getSchemas();

registry.clear();
```

`getSchemas()` returns `ToolSchema[]` (`{ name, description, parameters }`) for LLM function calling; a single tool converts with `tool.toJSON()`.

---

## Sandboxed Execution

Sandboxing needs `@cogitator-ai/sandbox` installed. The runtime creates a `SandboxManager` on first use from the Cogitator's `sandbox` config; if Docker/WASM are unavailable, the tool falls back to running `execute()` natively (a warning is logged).

### Docker Sandbox

For a `docker` sandbox the runtime does **not** call `execute()` inside the container: it runs the call's `command` argument with `sh -c` in the configured image (passing `cwd` and `env` arguments when present) and returns `{ stdout, stderr, exitCode, timedOut, duration, command }`. `execute()` is the native fallback.

```typescript
const runShell = tool({
  name: 'run_shell',
  description: 'Run a shell command in an isolated Python container',
  parameters: z.object({
    command: z.string().describe('Shell command, e.g. "python3 -c \'print(2 + 2)\'"'),
  }),

  sandbox: {
    type: 'docker',
    image: 'python:3.12-slim',
    resources: {
      memory: '512MB',
      cpuShares: 512,
      pidsLimit: 100,
    },
    network: { mode: 'none' },
    mounts: [{ source: '/workspace', target: '/workspace', readOnly: true }],
    timeout: 30_000,
  },

  execute: async ({ command }) => ({ error: 'Sandbox unavailable', command }),
});

const cog = new Cogitator({
  sandbox: {
    defaults: { timeout: 30_000 },
    pool: { maxSize: 5, idleTimeoutMs: 60_000 },
  },
});
```

`SandboxConfig` also accepts `workdir`, `env`, `user` and `resources.cpus`. See [Sandboxed Execution](https://cogitator.app/docs/deployment/sandbox).

### WASM Sandbox

For a `wasm` sandbox the call's arguments are passed to the module as JSON on stdin, and its stdout is parsed as JSON. `@cogitator-ai/wasm-tools` builds such tools:

```typescript
import { defineWasmTool } from '@cogitator-ai/wasm-tools';
import { z } from 'zod';

const imageProcessor = defineWasmTool({
  name: 'image_processor',
  description: 'Process images in WASM sandbox',
  wasmModule: './my-image-proc.wasm',
  wasmFunction: 'process',
  parameters: z.object({
    imageData: z.string(),
    operation: z.enum(['resize', 'crop', 'rotate']),
  }),
  timeout: 5_000,
});
```

### Pre-built WASM Tools

```typescript
import {
  createCalcTool,
  createHashTool,
  createBase64Tool,
  createJsonTool,
  createSlugTool,
  createValidationTool,
  createDiffTool,
  createRegexTool,
  createCsvTool,
  createMarkdownTool,
  createXmlTool,
  createDatetimeTool,
  createCompressionTool,
  createSigningTool,
} from '@cogitator-ai/wasm-tools';

const agent = new Agent({
  name: 'wasm-agent',
  model: 'openai/gpt-5.5',
  instructions: 'You process data with sandboxed tools.',
  tools: [createCalcTool(), createHashTool(), createBase64Tool(), createCsvTool()],
});
```

14 pre-built WASM tools: `calc`, `hash`, `base64`, `json`, `slug`, `validation`, `diff`, `regex`, `csv`, `markdown`, `xml`, `datetime`, `compression`, `signing`. Each factory takes `{ timeout }`.

---

## Tool Patterns

### Compound Tools

Tools that compose other tools:

```typescript
import { webSearch } from '@cogitator-ai/core';

const researchAndSummarize = tool({
  name: 'research_and_summarize',
  description: 'Search the web and summarize findings',
  parameters: z.object({
    topic: z.string(),
    depth: z.enum(['quick', 'thorough']).default('quick'),
  }),
  execute: async ({ topic, depth }, context) => {
    const results = await webSearch.execute(
      { query: topic, maxResults: depth === 'thorough' ? 10 : 3 },
      context
    );
    return { topic, results };
  },
});
```

### Stateful Tools

Tools that maintain state across calls (for real browser automation use `@cogitator-ai/browser`, see [Browser](https://cogitator.app/docs/browser)):

```typescript
class CounterSession {
  private count = 0;

  readonly tools = toolset(
    tool({
      name: 'counter_increment',
      description: 'Increment the counter',
      parameters: z.object({ by: z.number().int().default(1) }),
      execute: async ({ by }) => {
        this.count += by;
        return { count: this.count };
      },
    }),
    tool({
      name: 'counter_reset',
      description: 'Reset the counter',
      parameters: z.object({}),
      execute: async () => {
        this.count = 0;
        return { count: 0 };
      },
    })
  );
}
```

---

## Error Handling

Return error objects when the agent can recover; throw for fatal errors. A thrown error (or a timeout) is reported back to the model as `{ error }` for that call, and the run continues.

```typescript
class ValidationError extends Error {}

const safeTool = tool({
  name: 'safe_tool',
  description: 'Process input safely',
  parameters: z.object({ input: z.string() }),

  execute: async ({ input }) => {
    try {
      return await riskyOperation(input);
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          error: true,
          type: 'validation',
          message: error.message,
          suggestion: 'Try a different input format',
        };
      }

      throw error;
    }
  },
});
```

---

## Observability

Every tool call is recorded as a span named `tool.<name>` with `tool.name`, `tool.call_id`, `tool.arguments`, `tool.success` and `tool.error` attributes:

```typescript
const result = await cog.run(agent, { input: 'Search for TypeScript tutorials' });

for (const span of result.trace.spans.filter((s) => s.name.startsWith('tool.'))) {
  console.log(span.name, span.duration, span.attributes['tool.arguments']);
}

console.log(result.toolCalls);
```

Use `onToolCall` / `onToolResult` run options for live hooks. See [Observability](https://cogitator.app/docs/deployment/observability).

---

## Tool Testing

Use `MockLLMBackend` from `@cogitator-ai/test-utils` and register it as a custom backend:

```typescript
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { Cogitator, Agent, calculator } from '@cogitator-ai/core';

describe('Agent with Tools', () => {
  it('calls the calculator', async () => {
    const mock = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'calculator', arguments: { expression: '6 * 7' } }],
        finishReason: 'tool_calls',
      },
      { content: 'The answer is 42' },
    ]);

    const cog = new Cogitator({ llm: { backends: { mock } } });

    const agent = new Agent({
      name: 'test-agent',
      model: 'mock/test',
      instructions: 'Use the calculator for math.',
      tools: [calculator],
    });

    const result = await cog.run(agent, { input: 'Calculate 6 * 7' });

    expect(result.toolCalls[0]?.name).toBe('calculator');
    expect(result.output).toBe('The answer is 42');
    expect(mock.getCallCount()).toBe(2);
  });
});
```

See [Test Utilities](https://cogitator.app/docs/testing/test-utils).

---

## Best Practices

### 1. Clear Descriptions

```typescript
// Bad
tool({
  name: 'search',
  description: 'Searches',
  // ...
});

// Good
tool({
  name: 'search_codebase',
  description: `Search the codebase for files, functions, or patterns.
                Use this when you need to find specific code or understand
                the project structure.

                Examples:
                - Find all API routes: pattern="router.get|router.post"
                - Find a function: pattern="function calculateTotal"
                - Find files: pattern="*.test.ts"`,
  // ...
});
```

### 2. Helpful Error Messages

```typescript
execute: async ({ filePath }) => {
  if (!(await exists(filePath))) {
    const dir = dirname(filePath);
    const similar = await findSimilar(dir, basename(filePath));

    return {
      error: `File not found: ${filePath}`,
      suggestion:
        similar.length > 0
          ? `Did you mean: ${similar.join(', ')}?`
          : `Directory contents: ${await listDir(dir)}`,
    };
  }
  // ...
};
```

### 3. Resource Limits

```typescript
tool({
  name: 'process_data',
  description: 'Process a data payload',
  parameters: z.object({
    data: z.string().max(1_000_000),
  }),
  timeout: 30_000,
  execute: async ({ data }) => transform(data),
});
```

`timeout` aborts the call's `context.signal` and reports a timeout error to the model.

### 4. Idempotency

```typescript
import { mkdir } from 'node:fs/promises';

tool({
  name: 'ensure_directory',
  description: 'Ensure a directory exists (creates if needed)',
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    await mkdir(path, { recursive: true });
    return { exists: true, path };
  },
});
```
