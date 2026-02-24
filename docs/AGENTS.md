# Agents

> Patterns, configuration, and best practices for building agents

## Overview

An Agent in Cogitator is a configured LLM instance with:

- **Model** — The underlying LLM (Llama, GPT-4, Claude, Gemini, etc.)
- **Instructions** — System prompt defining behavior
- **Tools** — Capabilities the agent can use

Memory and sandbox are configured at the Cogitator runtime level, not on individual agents.

```typescript
interface AgentConfig {
  id?: string;
  name: string;
  description?: string;

  provider?: string; // Explicit provider override (e.g., 'openai' for OpenRouter)
  model: string; // 'ollama/llama3.3:70b', 'openai/gpt-4o'
  temperature?: number; // 0-2, default 0.7
  topP?: number; // 0-1
  maxTokens?: number; // Max output tokens
  stopSequences?: string[];

  instructions: string; // System prompt
  tools?: Tool[]; // Available tools
  responseFormat?: ResponseFormat; // Structured output

  maxIterations?: number; // Max tool use loops, default 10
  timeout?: number; // Max execution time in ms, default 120000
}
```

---

## Creating Agents

### Basic Agent

```typescript
import { Agent } from '@cogitator-ai/core';

const assistant = new Agent({
  name: 'assistant',
  model: 'ollama/llama3.3:latest',
  instructions: `You are a helpful assistant. Answer questions clearly and concisely.
                 If you don't know something, say so.`,
});
```

### Agent with Tools

```typescript
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const searchWeb = tool({
  name: 'search_web',
  description: 'Search the internet for current information',
  parameters: z.object({
    query: z.string().describe('The search query'),
    limit: z.number().default(5).describe('Number of results'),
  }),
  execute: async ({ query, limit }) => {
    const results = await searchAPI.search(query, limit);
    return results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
  },
});

const readUrl = tool({
  name: 'read_url',
  description: 'Read and extract content from a URL',
  parameters: z.object({
    url: z.string().url(),
  }),
  execute: async ({ url }) => {
    const content = await fetch(url).then((r) => r.text());
    return extractText(content);
  },
});

const researcher = new Agent({
  name: 'researcher',
  model: 'openai/gpt-4o',
  instructions: `You are a research assistant. Use your tools to find accurate,
                 up-to-date information. Always cite your sources.`,
  tools: [searchWeb, readUrl],
});
```

### Agent with Structured Output

```typescript
const analyzer = new Agent({
  name: 'analyzer',
  model: 'anthropic/claude-sonnet-4-5',
  instructions: 'Analyze the given text and extract structured information.',
  responseFormat: {
    type: 'json_schema',
    schema: z.object({
      summary: z.string(),
      sentiment: z.enum(['positive', 'negative', 'neutral']),
      keyPoints: z.array(z.string()),
      entities: z.array(
        z.object({
          name: z.string(),
          type: z.enum(['person', 'organization', 'location', 'other']),
        })
      ),
    }),
  },
});
```

### Agent with Persistent Memory

Memory is configured at the Cogitator runtime level, not on individual agents:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    defaultModel: 'openai/gpt-4.1',
  },
  memory: {
    adapter: 'postgres',
    postgres: { connectionString: process.env.DATABASE_URL },
    embedding: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
    },
    contextBuilder: {
      maxTokens: 8000,
      strategy: 'hybrid',
    },
  },
});

const personalAssistant = new Agent({
  name: 'personal-assistant',
  model: 'openai/gpt-4.1',
  instructions: `You are a personal assistant. Remember user preferences
                 and context from previous conversations.`,
});

await cog.run(personalAssistant, {
  input: 'Remember I prefer dark mode',
  threadId: 'user-alice',
});
```

---

## Agent Patterns

### 1. Planner Agent

Breaks down complex tasks into subtasks.

```typescript
const planner = new Agent({
  name: 'planner',
  model: 'openai/gpt-4o',
  temperature: 0.2,
  instructions: `You are a task planning agent. When given a complex task:
                 1. Analyze the requirements
                 2. Break it into specific, actionable subtasks
                 3. Identify dependencies between subtasks
                 4. Return a structured plan`,
  responseFormat: {
    type: 'json_schema',
    schema: z.object({
      goal: z.string(),
      subtasks: z.array(
        z.object({
          id: z.string(),
          description: z.string(),
          dependencies: z.array(z.string()),
          estimatedComplexity: z.enum(['low', 'medium', 'high']),
        })
      ),
    }),
  },
});
```

### 2. Executor Agent

Executes specific tasks with tools.

```typescript
const executor = new Agent({
  name: 'executor',
  model: 'anthropic/claude-sonnet-4-5',
  instructions: `You are a task execution agent. Execute the given task precisely.
                 Use tools when needed. Report success or failure clearly.`,
  tools: [fileRead, fileWrite, exec, webSearch],
  maxIterations: 20,
});
```

### 3. Critic Agent

Reviews and validates work.

```typescript
const critic = new Agent({
  name: 'critic',
  model: 'openai/gpt-4o',
  temperature: 0.1,
  instructions: `You are a code review agent. Review code for:
                 - Bugs and logic errors
                 - Security vulnerabilities
                 - Performance issues
                 - Code style and best practices

                 Be thorough but constructive.`,
  responseFormat: {
    type: 'json_schema',
    schema: z.object({
      approved: z.boolean(),
      issues: z.array(
        z.object({
          severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
          location: z.string(),
          description: z.string(),
          suggestion: z.string().optional(),
        })
      ),
      summary: z.string(),
    }),
  },
});
```

### 4. Routing Agent

Routes requests to specialized agents.

```typescript
const router = new Agent({
  name: 'router',
  model: 'openai/gpt-4o-mini',
  temperature: 0,
  instructions: `You are a routing agent. Analyze the user's request and determine
                 which specialized agent should handle it.

                 Available agents:
                 - coder: Writing and modifying code
                 - researcher: Finding information
                 - analyst: Analyzing data
                 - writer: Creating documents`,
  responseFormat: {
    type: 'json_schema',
    schema: z.object({
      targetAgent: z.enum(['coder', 'researcher', 'analyst', 'writer']),
      reasoning: z.string(),
      refinedPrompt: z.string(),
    }),
  },
});
```

### 5. Reflection Agent

Self-improves through reflection.

```typescript
const reflectiveAgent = new Agent({
  name: 'reflective-coder',
  model: 'anthropic/claude-sonnet-4-5',
  instructions: `You are a thoughtful coder. For each task:

                 1. THINK: Analyze the requirements
                 2. PLAN: Outline your approach
                 3. CODE: Write the solution
                 4. REFLECT: Review your work for issues
                 5. IMPROVE: Fix any problems found

                 Always show your thinking process.`,
  maxIterations: 15,
});
```

---

## Agent Configuration Reference

### Model Selection

Models use the `provider/model` format:

```typescript
// Local models (via Ollama)
model: 'ollama/llama3.3:latest';
model: 'ollama/codellama:34b';
model: 'ollama/mistral:7b-instruct';

// OpenAI
model: 'openai/gpt-4o';
model: 'openai/gpt-4o-mini';
model: 'openai/o1-preview';

// Anthropic
model: 'anthropic/claude-sonnet-4-5';
model: 'anthropic/claude-opus-4-5';

// Google
model: 'google/gemini-2.5-flash';
model: 'google/gemini-2.5-pro';

// Azure OpenAI
model: 'azure/my-deployment-name';

// AWS Bedrock
model: 'bedrock/anthropic.claude-sonnet-4-5-20250514-v1:0';
```

### Temperature Guidelines

| Use Case          | Temperature | Reasoning                   |
| ----------------- | ----------- | --------------------------- |
| Code generation   | 0.0 - 0.2   | Deterministic, correct code |
| Planning          | 0.2 - 0.4   | Consistent but flexible     |
| General assistant | 0.5 - 0.7   | Balanced                    |
| Creative writing  | 0.8 - 1.2   | More varied output          |
| Brainstorming     | 1.0 - 1.5   | Maximum creativity          |

---

## Tool Integration

### Built-in Tools

Cogitator ships with built-in tools exported from `@cogitator-ai/core`:

```typescript
import {
  fileRead,
  fileWrite,
  fileList,
  fileExists,
  fileDelete,
  exec,
  webSearch,
  webScrape,
  calculator,
  httpRequest,
  sqlQuery,
  vectorSearch,
  sendEmail,
  githubApi,
  builtinTools,
} from '@cogitator-ai/core';

const agent = new Agent({
  name: 'worker',
  model: 'openai/gpt-4o',
  instructions: 'You are a helpful worker.',
  tools: [fileRead, fileWrite, exec],
});
```

### Custom Tools

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const createIssue = tool({
  name: 'create_github_issue',
  description: 'Creates a new issue in a GitHub repository',
  parameters: z.object({
    repo: z.string().describe('Repository in format owner/repo'),
    title: z.string().max(256).describe('Issue title'),
    body: z.string().describe('Issue description in markdown'),
    labels: z.array(z.string()).optional().describe('Labels to apply'),
  }),
  execute: async ({ repo, title, body, labels }) => {
    const result = await githubService.createIssue({ repo, title, body, labels });
    return { issueNumber: result.number, url: result.html_url };
  },
});
```

### MCP Tool Servers

Use `@cogitator-ai/mcp` to connect to external MCP servers:

```typescript
import { MCPClient } from '@cogitator-ai/mcp';
import { Agent } from '@cogitator-ai/core';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/allowed/path'],
});

const fsTools = await client.getTools();

const agent = new Agent({
  name: 'file-worker',
  model: 'openai/gpt-4o',
  instructions: 'You can read and write files.',
  tools: [...fsTools],
});

// Don't forget to disconnect when done
await client.close();
```

Or use the convenience `connectMCPServer` function:

```typescript
import { connectMCPServer } from '@cogitator-ai/mcp';

const { tools, cleanup } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/allowed/path'],
});

const agent = new Agent({
  name: 'file-worker',
  model: 'openai/gpt-4o',
  instructions: 'You can read and write files.',
  tools: [...tools],
});

await cleanup();
```

---

## Execution

Agents are run via the `Cogitator` runtime:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: { defaultModel: 'openai/gpt-4o' },
});

const agent = new Agent({
  name: 'assistant',
  model: 'openai/gpt-4o',
  instructions: 'You are a helpful assistant.',
  maxIterations: 20,
  timeout: 300_000,
});

const result = await cog.run(agent, {
  input: 'What is the capital of France?',
});

console.log(result.output); // "The capital of France is Paris."
console.log(result.usage); // { inputTokens, outputTokens, totalTokens, cost, duration }
```

### Run Options

```typescript
const result = await cog.run(agent, {
  input: 'Analyze this data',
  threadId: 'user-alice',
  timeout: 300_000,
  stream: true,
  parallelToolCalls: true,

  onToken: (token) => process.stdout.write(token),
  onToolCall: (call) => console.log(`Calling: ${call.name}`),
  onToolResult: (result) => console.log(`Result: ${result.name}`),
  onRunStart: ({ runId, agentId }) => console.log(`Run ${runId} started`),
  onRunComplete: (result) => console.log(`Done: ${result.output}`),
  onRunError: (error, runId) => console.error(`Run ${runId} failed:`, error),

  useMemory: true,
  loadHistory: true,
  saveHistory: true,
});
```

### Run Result

```typescript
interface RunResult {
  readonly output: string;
  readonly structured?: unknown;
  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly modelUsed?: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly duration: number;
  };
  readonly toolCalls: readonly ToolCall[];
  readonly messages: readonly Message[];
  readonly trace: {
    readonly traceId: string;
    readonly spans: readonly Span[];
  };
}
```

---

## Cloning and Serialization

### Cloning

Create variants of an agent with configuration overrides:

```typescript
const baseAgent = new Agent({
  name: 'coder',
  model: 'anthropic/claude-sonnet-4-5',
  instructions: 'You write clean TypeScript code.',
});

const creativeAgent = baseAgent.clone({ temperature: 0.9 });
const fastAgent = baseAgent.clone({ model: 'anthropic/claude-haiku-4-5' });
```

### Serialization

Agents can be serialized to JSON and restored:

```typescript
import { Agent, ToolRegistry } from '@cogitator-ai/core';
import fs from 'fs/promises';

const snapshot = agent.serialize();
await fs.writeFile('agent.json', JSON.stringify(snapshot, null, 2));

const loaded = JSON.parse(await fs.readFile('agent.json', 'utf-8'));
const restored = Agent.deserialize(loaded, {
  toolRegistry, // ToolRegistry to resolve tool names
  // or: tools: [searchWeb, readUrl],
});
```

---

## Testing Agents

### Unit Testing

Use `@cogitator-ai/test-utils` for mock backends:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { MockLLMBackend, createTestTool } from '@cogitator-ai/test-utils';

describe('Researcher Agent', () => {
  it('should search and summarize results', async () => {
    const mockLLM = new MockLLMBackend();

    mockLLM.setResponses([
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'search_web', arguments: { query: 'WebGPU' } }],
        finishReason: 'tool_calls',
      },
      {
        content: 'WebGPU is a new graphics API...',
        finishReason: 'stop',
      },
    ]);

    const searchTool = createTestTool({
      name: 'search_web',
      result: [{ title: 'WebGPU Spec', url: 'https://gpuweb.github.io/gpuweb/' }],
    });

    const agent = new Agent({
      name: 'test-researcher',
      model: 'openai/gpt-4o',
      instructions: 'You are a research assistant.',
      tools: [searchTool],
    });

    // Use the mock backend via Cogitator
    // ... run and assert
    expect(mockLLM.getCalls()).toHaveLength(2);
  });
});
```

### Integration Testing

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

describe('Agent Integration', () => {
  let cog: Cogitator;

  beforeAll(async () => {
    cog = new Cogitator({
      llm: { defaultModel: 'ollama/llama3.3:latest' },
    });
  });

  it('should complete a real task', async () => {
    const agent = new Agent({
      name: 'test-agent',
      model: 'ollama/llama3.3:latest',
      instructions: 'You are a helpful assistant.',
    });

    const result = await cog.run(agent, {
      input: 'What is 2 + 2?',
    });

    expect(result.output).toContain('4');
  });
});
```

### Evaluation

Use `@cogitator-ai/evals` for systematic evaluation:

```typescript
import { EvalSuite, Dataset, exactMatch, contains } from '@cogitator-ai/evals';

const dataset = Dataset.from([
  {
    input: 'Calculate the factorial of 5',
    expected: '120',
  },
  {
    input: 'What is the capital of France?',
    expected: 'Paris',
  },
]);

const suite = new EvalSuite({
  dataset,
  target: {
    fn: async (input) => {
      const result = await cog.run(agent, { input });
      return result.output;
    },
  },
  metrics: [exactMatch, contains],
});

const results = await suite.run();
```

---

## Best Practices

### 1. Clear Instructions

```typescript
// Bad
instructions: 'Help the user';

// Good
instructions: `You are a Python code assistant. Your role is to:
               1. Write clean, PEP-8 compliant code
               2. Include type hints for all functions
               3. Add docstrings explaining the purpose
               4. Handle edge cases appropriately

               If the request is unclear, ask for clarification.`;
```

### 2. Appropriate Model Selection

```typescript
// Use smaller models for simple tasks
const classifier = new Agent({
  name: 'classifier',
  model: 'openai/gpt-4o-mini',
  instructions: 'Classify the input into one of the categories.',
});

// Use powerful models for complex reasoning
const architect = new Agent({
  name: 'architect',
  model: 'anthropic/claude-opus-4-5',
  instructions: 'Design system architecture.',
});
```

### 3. Tool Design

```typescript
// Bad: Vague tool
tool({
  name: 'do_stuff',
  description: 'Does various things',
  parameters: z.object({ input: z.string() }),
  execute: async ({ input }) => input,
});

// Good: Specific, well-documented tool
tool({
  name: 'create_github_issue',
  description:
    'Creates a new issue in a GitHub repository. Use this when you need to report a bug or request a feature.',
  parameters: z.object({
    repo: z.string().describe('Repository in format owner/repo'),
    title: z.string().max(256).describe('Issue title'),
    body: z.string().describe('Issue description in markdown'),
    labels: z.array(z.string()).optional().describe('Labels to apply'),
  }),
  execute: async ({ repo, title, body, labels }) => {
    return await github.createIssue({ repo, title, body, labels });
  },
});
```

### 4. Resource Limits

```typescript
const agent = new Agent({
  name: 'worker',
  model: 'openai/gpt-4o',
  instructions: 'You are a task execution agent.',
  maxIterations: 20,
  timeout: 300_000,
});
```

---

## Context Window Management

When conversations exceed the model's context window, Cogitator can automatically compress messages. This is configured at the runtime level:

```typescript
const cog = new Cogitator({
  llm: { defaultModel: 'openai/gpt-4o' },
  context: {
    enabled: true,
    strategy: 'hybrid', // 'truncate' | 'sliding-window' | 'summarize' | 'hybrid'
    compressionThreshold: 0.8, // Compress when 80% of context used
    outputReserve: 0.15, // Reserve 15% for output
    summaryModel: 'openai/gpt-4o-mini', // Model used for summarization
    windowSize: 10, // Messages to keep in sliding window
    windowOverlap: 2, // Overlap between windows
  },
});
```

Four strategies are available:

| Strategy         | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `truncate`       | Drops oldest messages beyond the limit               |
| `sliding-window` | Keeps a fixed-size window of recent messages         |
| `summarize`      | Summarizes older messages using an LLM               |
| `hybrid`         | Combines summarization with sliding window (default) |

The runtime automatically applies compression during `cog.run()` when the context approaches the model's limit.

---

## Retry and Error Handling

Cogitator provides retry utilities for wrapping unreliable operations:

```typescript
import { withRetry, retryable } from '@cogitator-ai/core';

const result = await withRetry(() => fetchFromAPI(), {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential', // 'exponential' | 'linear' | 'constant'
  jitter: 0.1,
  onRetry: (error, attempt, delay) => {
    console.log(`Retry ${attempt} in ${delay}ms: ${error.message}`);
  },
});

// Or create a reusable retryable function
const retryableFetch = retryable(fetchFromAPI, { maxRetries: 3 });
const data = await retryableFetch(url);
```

For per-run error handling, use RunOptions callbacks:

```typescript
const result = await cog.run(agent, {
  input: 'Do something risky',
  onRunError: (error, runId) => {
    console.error(`Run ${runId} failed:`, error);
  },
  onMemoryError: (error, operation) => {
    console.warn(`Memory ${operation} failed:`, error);
  },
});
```

LLM backend errors include a `retryable` flag — Cogitator's built-in backends automatically set this based on HTTP status codes (429, 500, 503).

---

## Human-in-the-Loop

### Tool Approval

Individual tools can require approval before execution via `requiresApproval`:

```typescript
const deleteTool = tool({
  name: 'delete_file',
  description: 'Delete a file from the filesystem',
  parameters: z.object({ path: z.string() }),
  requiresApproval: true, // Always require approval
  execute: async ({ path }) => {
    await fs.unlink(path);
    return { deleted: path };
  },
});

// Or conditionally based on params
const shellTool = tool({
  name: 'exec',
  description: 'Execute a shell command',
  parameters: z.object({ command: z.string() }),
  requiresApproval: ({ command }) => command.includes('rm') || command.includes('sudo'),
  execute: async ({ command }) => {
    /* ... */
  },
});
```

At the runtime level, the guardrails system provides `onToolApproval`:

```typescript
const cog = new Cogitator({
  guardrails: {
    enabled: true,
    filterToolCalls: true,
    onToolApproval: async (toolName, args, sideEffects) => {
      console.log(`Agent wants to call ${toolName} with:`, args);
      console.log(`Side effects: ${sideEffects.join(', ')}`);
      return await askHuman(`Approve ${toolName}?`);
    },
  },
});
```

### Workflow Approval Nodes

For complex approval workflows, use `@cogitator-ai/workflows`:

```typescript
import { DAGWorkflow, approvalNode } from '@cogitator-ai/workflows';

const workflow = new DAGWorkflow<{ content: string; approved: boolean }>()
  .addNode('generate', {
    execute: async (state) => ({ ...state, content: 'Generated content' }),
  })
  .addNode(
    'review',
    approvalNode({
      approval: {
        type: 'approve-reject',
        title: 'Review generated content',
        assignee: 'editor',
        timeout: 60_000,
        timeoutAction: 'escalate',
        escalateTo: 'manager',
      },
    })
  )
  .addEdge('generate', 'review');
```

---

## Run Lifecycle Callbacks

The `RunOptions` provide callbacks for observing agent execution. These are per-run hooks, not per-agent:

```typescript
const result = await cog.run(agent, {
  input: 'Build a website',

  onRunStart: ({ runId, agentId, input, threadId }) => {
    console.log(`Run ${runId} started for agent ${agentId}`);
  },

  onToken: (token) => {
    process.stdout.write(token);
  },

  onToolCall: (call) => {
    console.log(`Calling tool: ${call.name}(${JSON.stringify(call.arguments)})`);
  },

  onToolResult: (result) => {
    console.log(`Tool ${result.name} returned:`, result.content);
  },

  onSpan: (span) => {
    console.log(`Span: ${span.name} [${span.duration}ms]`);
  },

  onRunComplete: (result) => {
    console.log(`Completed in ${result.usage.duration}ms`);
    console.log(`Tokens: ${result.usage.totalTokens}, Cost: $${result.usage.cost}`);
  },

  onRunError: (error, runId) => {
    console.error(`Run ${runId} failed:`, error.message);
  },

  onMemoryError: (error, operation) => {
    console.warn(`Memory ${operation} failed (non-fatal):`, error);
  },
});
```

For production observability, use the built-in exporters:

```typescript
import { LangfuseExporter, OTLPExporter } from '@cogitator-ai/core';

const langfuse = createLangfuseExporter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
});

// The exporter hooks into onRunStart, onRunComplete, onToolCall, etc.
```
