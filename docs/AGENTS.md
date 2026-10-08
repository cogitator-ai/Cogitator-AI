# Agents

> Patterns, configuration, and best practices for building agents

## Overview

An Agent in Cogitator is a configured LLM persona with:

- **Model** — The underlying LLM (`provider/model`; optional, falls back to `llm.defaultModel` of the Cogitator that runs it)
- **Instructions** — System prompt defining behavior
- **Tools** — Capabilities the agent can use

An `Agent` is only configuration: it has no `run()` method. Runs go through the `Cogitator` runtime (`cog.run(agent, { input })`), and memory, sandbox, guardrails, retries and context management are configured there, not on individual agents.

```typescript
interface AgentConfig {
  id?: string; // Stable id; generated when left out
  name: string;
  description?: string; // Describes the agent to agents that can hand off to it

  provider?: string; // Explicit provider override (e.g., 'openai' for OpenRouter)
  model?: string; // 'ollama/llama3.3', 'openai/gpt-6.1-sol'; default: llm.defaultModel
  temperature?: number; // default 0.7
  topP?: number;
  maxTokens?: number; // Max output tokens
  stopSequences?: string[];

  instructions: string; // System prompt
  tools?: Tool[]; // Available tools
  skills?: Skill[]; // Bundles of tools + instructions merged into the agent
  responseFormat?: ResponseFormat; // Structured output
  reasoning?: ReasoningConfig; // Effort and summaries for reasoning models
  handoffs?: Array<Agent | Handoff>; // Agents this one can hand the conversation to

  maxIterations?: number; // Max tool-use loops, default 10
  timeout?: number; // Run timeout in ms; default limits.defaultTimeout, else 120000
}
```

See [Agents](https://cogitator.app/docs/core/agents) and [Cogitator](https://cogitator.app/docs/core/cogitator) on the website for the full reference.

---

## Creating Agents

### Basic Agent

```typescript
import { Agent } from '@cogitator-ai/core';

const assistant = new Agent({
  name: 'assistant',
  model: 'ollama/llama3.3',
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
  model: 'openai/gpt-6.1-sol',
  instructions: `You are a research assistant. Use your tools to find accurate,
                 up-to-date information. Always cite your sources.`,
  tools: [searchWeb, readUrl],
});
```

### Agent with Structured Output

```typescript
const analyzer = new Agent({
  name: 'analyzer',
  model: 'anthropic/claude-sonnet-5-5',
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

const result = await cog.run(analyzer, { input: article });
result.structured; // the parsed object, or undefined when the answer did not match
```

The schema is sent to the provider as JSON Schema (strict mode when every property is required). When the final answer still does not match it, the runtime asks the model once more with the validation problem before giving up; `result.output` always keeps the raw text. `responseFormat: { type: 'json' }` asks for any JSON object. See [Structured Outputs](https://cogitator.app/docs/core/structured-outputs).

### Agent with Persistent Memory

Memory is configured at the Cogitator runtime level, not on individual agents:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: {
    defaultModel: 'openai/gpt-6.1-sol',
  },
  memory: {
    adapter: 'postgres', // 'memory' | 'redis' | 'postgres'
    postgres: { connectionString: process.env.DATABASE_URL! },
    embedding: {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY!,
    },
    contextBuilder: {
      maxTokens: 8000,
      strategy: 'hybrid', // 'recent' | 'relevant' | 'hybrid'
    },
  },
});

const personalAssistant = new Agent({
  name: 'personal-assistant', // no model: runs on llm.defaultModel
  instructions: `You are a personal assistant. Remember user preferences
                 and context from previous conversations.`,
});

await cog.run(personalAssistant, {
  input: 'Remember I prefer dark mode',
  threadId: 'thread-alice',
  userId: 'alice',
});

const memory = await cog.getMemory(); // connects on first use, before any run
```

The runtime builds the `memory`, `redis` and `postgres` adapters from config. For SQLite, MongoDB or your own adapter, create it with `@cogitator-ai/memory`, call `connect()` and assign it: `cog.memory = adapter`. With `userId`, threads belong to that user and other users cannot continue them (`threadAccess: 'shared'` opts out) — see [Multi-User](https://cogitator.app/docs/advanced/multi-user).

---

## Agent Patterns

### 1. Planner Agent

Breaks down complex tasks into subtasks.

```typescript
const planner = new Agent({
  name: 'planner',
  model: 'openai/gpt-6.1-sol',
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
import { fileRead, fileWrite, exec, webSearch } from '@cogitator-ai/core';

const executor = new Agent({
  name: 'executor',
  model: 'anthropic/claude-sonnet-5-5',
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
  model: 'openai/gpt-6.1-sol',
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

### 4. Triage Agent with Handoffs

Hands the conversation to a specialist. Each entry in `handoffs` becomes a `transfer_to_<name>` tool described by the target's `description`; when the model calls it, the rest of the run goes on as the target agent (its instructions, tools, model and reasoning) with the whole conversation.

```typescript
const coder = new Agent({
  name: 'coder',
  description: 'Writing and modifying code',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You write and fix code.',
});

const researcher = new Agent({
  name: 'researcher',
  description: 'Finding information',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You research questions and cite sources.',
});

const triage = new Agent({
  name: 'triage',
  model: 'openai/gpt-6-luna',
  temperature: 0,
  instructions: 'Hand the request to the specialist that fits it.',
  handoffs: [coder, { agent: researcher, toolName: 'ask_researcher' }],
});

const result = await cog.run(triage, {
  input: 'Find the latest WebGPU spec changes',
  onHandoff: ({ from, to }) => console.log(`${from} -> ${to}`),
});

result.handoffs; // [{ from: 'triage', to: 'researcher', reason: '...' }]
result.finalAgent; // 'researcher' — send the next message of this thread to it
```

To keep the conversation in the caller and use a specialist only for one answer, wrap it with `agentAsTool(cog, agent, options)` instead. For coordinated multi-agent strategies, see `@cogitator-ai/swarms`.

### 5. Reflection Agent

Self-improves through reflection.

```typescript
const reflectiveAgent = new Agent({
  name: 'reflective-coder',
  model: 'anthropic/claude-sonnet-5-5',
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

The runtime can also reflect for you: `new Cogitator({ reflection: { enabled: true, reflectAfterError: true, reflectAtEnd: true } })` analyzes failed tool calls (or every call with `reflectAfterToolCall`), adds the suggested fix to the conversation before the next model call, and stores insights for later runs. See [Reflection](https://cogitator.app/docs/advanced/reflection).

---

## Agent Configuration Reference

### Model Selection

Models use the `provider/model` format:

```text
ollama/llama3.3              Local models via Ollama
ollama/qwen2.5-coder:32b

openai/gpt-6.1-sol           OpenAI
openai/gpt-6-luna
openai/gpt-6-astra

anthropic/claude-opus-5-5    Anthropic
anthropic/claude-sonnet-5-5

google/gemini-3.8-flash      Google Gemini
google/gemini-3.1-pro-preview

azure/my-deployment-name     Azure OpenAI
bedrock/global.anthropic.claude-sonnet-5-5   AWS Bedrock
```

Other built-in providers: `vllm`, `mistral`, `groq`, `together`, `deepseek`. A prefix that is not a known provider runs the whole string on `llm.defaultProvider` (Ollama when unset). Provider credentials go in `llm.providers`; your own `LLMBackend`s go in `llm.backends` (an agent with model `name/model` runs on the backend registered as `name`). An agent without `model` uses `llm.defaultModel`; a run with neither fails with `CONFIGURATION_ERROR`.

### Reasoning

Reasoning models think before they answer. `reasoning` sets how hard, in one vocabulary for every provider, and can ask for a readable summary:

```typescript
const analyst = new Agent({
  name: 'analyst',
  model: 'anthropic/claude-opus-5-5',
  instructions: 'Answer questions about the quarterly numbers.',
  reasoning: { effort: 'high', summary: true }, // effort: 'none' ... 'max'
});

const result = await cog.run(analyst, {
  input: 'Why did margins drop in Q3?',
  stream: true,
  onToken: (token) => process.stdout.write(token),
  onReasoning: (delta) => process.stderr.write(delta),
});

result.reasoning; // the whole summary
result.usage.reasoningTokens; // thinking tokens, already counted in outputTokens
```

A run can override it with `cog.run(agent, { input, reasoning })`. `budgetTokens` sets a thinking budget for providers that take one. See [Agents: Reasoning](https://cogitator.app/docs/core/agents#reasoning); for Tree-of-Thought exploration on top of a model, see [Tree-of-Thought Reasoning](https://cogitator.app/docs/advanced/reasoning).

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

Cogitator ships with built-in tools exported from `@cogitator-ai/core`, among them:

```typescript
import {
  calculator,
  datetime,
  fileRead,
  fileWrite,
  fileList,
  fileExists,
  fileDelete,
  exec,
  httpRequest,
  webSearch,
  webScrape,
  sqlQuery,
  vectorSearch,
  sendEmail,
  githubApi,
  builtinTools,
} from '@cogitator-ai/core';

const agent = new Agent({
  name: 'worker',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You are a helpful worker.',
  tools: [fileRead, fileWrite, exec],
});
```

See [Built-in Tools](https://cogitator.app/docs/tools/built-in) for the full list and the environment variables each one needs.

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

The second argument of `execute` is the run context: `agentId`, `runId`, `threadId`, `userId` and an abort `signal`.

When a factory returns several tools, wrap them in `toolset()`: the result is still a `Tool[]` an agent accepts, but each element keeps its own parameter and result types.

```typescript
import { tool, toolset } from '@cogitator-ai/core';

function createGitHubTools(token: string) {
  return toolset(
    tool({
      name: 'list_issues',
      description: 'List open issues of a repository',
      parameters: z.object({ repo: z.string() }),
      execute: async ({ repo }) => github.listIssues(repo, token),
    }),
    tool({
      name: 'close_issue',
      description: 'Close an issue',
      parameters: z.object({ repo: z.string(), number: z.number() }),
      execute: async ({ repo, number }) => github.closeIssue(repo, number, token),
    })
  );
}

const [listIssues, closeIssue] = createGitHubTools(process.env.GITHUB_TOKEN!);
```

### MCP Tool Servers

Use `@cogitator-ai/mcp` to connect to external MCP servers:

```typescript
import { MCPClient } from '@cogitator-ai/mcp';
import { Agent } from '@cogitator-ai/core';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
});

const agent = new Agent({
  name: 'file-worker',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You can read and write files.',
  tools: await client.getTools(),
});

try {
  await cog.run(agent, { input: 'List the files in the project' });
} finally {
  await client.close();
}
```

Or use the convenience `connectMCPServer` function, which returns the client, its tools and a `cleanup` function:

```typescript
import { connectMCPServer } from '@cogitator-ai/mcp';

const { tools, cleanup } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
});

const agent = new Agent({
  name: 'file-worker',
  model: 'openai/gpt-6.1-sol',
  instructions: 'You can read and write files.',
  tools,
});

// ... run the agent, then:
await cleanup();
```

See [MCP](https://cogitator.app/docs/integrations/mcp), including serving your own agents as MCP tools.

---

## Execution

Agents are run via the `Cogitator` runtime:

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

const cog = new Cogitator({
  llm: { defaultModel: 'openai/gpt-6.1-sol' },
});

const agent = new Agent({
  name: 'assistant',
  instructions: 'You are a helpful assistant.',
  maxIterations: 20,
  timeout: 300_000,
});

const result = await cog.run(agent, {
  input: 'What is the capital of France?',
});

console.log(result.output); // "The capital of France is Paris."
console.log(result.usage); // { inputTokens, outputTokens, totalTokens, cost, duration, ... }

await cog.close(); // release memory adapters and sandboxes
```

### Run Options

```typescript
const controller = new AbortController();

const result = await cog.run(agent, {
  input: 'Analyze this data',
  images: ['https://example.com/chart.png'], // URLs or { data, mimeType }
  context: { plan: 'pro' }, // added to the system prompt
  threadId: 'thread-alice',
  userId: 'alice',
  timeout: 300_000,
  signal: controller.signal,
  stream: true, // streams only together with onToken
  parallelToolCalls: true,
  reasoning: { effort: 'low' },

  onToken: (token) => process.stdout.write(token),
  onToolCall: (call) => console.log(`Calling: ${call.name}`),
  onToolResult: (result) => console.log(`Result: ${result.name}`),
  onApproval: async (request) => ({ approved: true }), // see Human-in-the-Loop
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
  readonly structured?: unknown; // parsed responseFormat output
  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly modelUsed?: string; // differs from agent.model with cost routing
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly duration: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly reasoning?: string; // reasoning summary (reasoning.summary)
  readonly prompt?: RunPrompt; // instruction version / A/B variant used
  readonly handoffs?: readonly HandoffEvent[];
  readonly finalAgent?: string;
  readonly status?: 'completed' | 'paused';
  readonly pendingApprovals?: readonly ToolApprovalRequest[];
  readonly checkpoint?: RunCheckpoint; // pass to cog.resume()
  readonly toolCalls: readonly ToolCall[];
  readonly messages: readonly Message[];
  readonly trace: {
    readonly traceId: string;
    readonly spans: readonly Span[];
  };
  readonly reflections?: readonly Reflection[];
  readonly reflectionSummary?: ReflectionSummary;
}
```

---

## Cloning and Serialization

### Cloning

Create variants of an agent with configuration overrides (the clone gets a new id):

```typescript
const baseAgent = new Agent({
  name: 'coder',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'You write clean TypeScript code.',
});

const creativeAgent = baseAgent.clone({ temperature: 0.9 });
const fastAgent = baseAgent.clone({ model: 'anthropic/claude-haiku-4-5' });
```

### Serialization

Agents can be serialized to JSON and restored. Tools are stored by name and resolved again on load:

```typescript
import { Agent, ToolRegistry } from '@cogitator-ai/core';
import fs from 'fs/promises';

const snapshot = agent.serialize();
await fs.writeFile('agent.json', JSON.stringify(snapshot, null, 2));

const loaded = JSON.parse(await fs.readFile('agent.json', 'utf-8'));
const restored = Agent.deserialize(loaded, {
  toolRegistry, // ToolRegistry to resolve tool names
  // or: tools: [searchWeb, readUrl],
  // overrides: { responseFormat: { type: 'json_schema', schema } },
});
```

A missing tool throws `AgentDeserializationError`. A `json_schema` response format is saved by name only; pass the Zod schema back in `overrides.responseFormat`. Snapshots must contain a `model`, so serialize agents that set one explicitly.

---

## Testing Agents

### Unit Testing

Give the `Cogitator` a scripted backend in `llm.backends` and point the agent's model at it. `@cogitator-ai/test-utils` ships one:

```typescript
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { MockLLMBackend, createToolCall } from '@cogitator-ai/test-utils';
import { z } from 'zod';

describe('Researcher Agent', () => {
  it('searches and summarizes results', async () => {
    const mock = new MockLLMBackend().setResponses([
      { toolCalls: [createToolCall('search_web', { query: 'WebGPU' })] },
      { content: 'WebGPU is a new graphics API...' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock } } });

    const searchWeb = tool({
      name: 'search_web',
      description: 'Search the web',
      parameters: z.object({ query: z.string() }),
      execute: async () => [{ title: 'WebGPU Spec', url: 'https://gpuweb.github.io/gpuweb/' }],
    });

    const agent = new Agent({
      name: 'test-researcher',
      model: 'mock/test-model',
      instructions: 'You are a research assistant.',
      tools: [searchWeb],
    });

    const result = await cog.run(agent, { input: 'What is WebGPU?' });

    expect(result.output).toBe('WebGPU is a new graphics API...');
    expect(result.toolCalls[0]).toMatchObject({ name: 'search_web' });
    expect(mock.getCallCount()).toBe(2);

    await cog.close();
  });
});
```

The runtime retries failed LLM calls, so set `llm: { backends, retry: false }` when you script errors. See [Testing](https://cogitator.app/docs/testing).

### Integration Testing

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';

describe('Agent Integration', () => {
  let cog: Cogitator;

  beforeAll(() => {
    cog = new Cogitator({
      llm: { defaultModel: 'ollama/llama3.3' },
    });
  });

  afterAll(() => cog.close());

  it('completes a real task', async () => {
    const agent = new Agent({
      name: 'test-agent',
      instructions: 'You are a helpful assistant.',
      temperature: 0,
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
  target: { agent, cogitator: cog }, // or { fn: async (input) => '...' }
  metrics: [exactMatch(), contains()],
});

const results = await suite.run();
```

See [Evals](https://cogitator.app/docs/evals).

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

To change instructions without redeploying code, deploy versions with `cog.prompts` (below).

### 2. Appropriate Model Selection

```typescript
// Use smaller models for simple tasks
const classifier = new Agent({
  name: 'classifier',
  model: 'openai/gpt-6-luna',
  instructions: 'Classify the input into one of the categories.',
});

// Use powerful models for complex reasoning
const architect = new Agent({
  name: 'architect',
  model: 'anthropic/claude-opus-5-5',
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
  model: 'openai/gpt-6.1-sol',
  instructions: 'You are a task execution agent.',
  maxIterations: 20,
  timeout: 300_000,
});

const cog = new Cogitator({
  limits: {
    maxConcurrentRuns: 10, // further runs wait for a slot
    defaultTimeout: 120_000, // for agents and runs without a timeout
    maxTokensPerRun: 200_000, // fails the run with RUN_TOKEN_LIMIT_EXCEEDED
  },
});
```

---

## Context Window Management

When conversations exceed the model's context window, Cogitator can automatically compress messages. This is configured at the runtime level and is on whenever `context` is set (unless `enabled: false`):

```typescript
const cog = new Cogitator({
  llm: { defaultModel: 'openai/gpt-6.1-sol' },
  context: {
    strategy: 'hybrid', // 'truncate' | 'sliding-window' | 'summarize' | 'hybrid'
    compressionThreshold: 0.8, // Compress when 80% of context used
    outputReserve: 0.15, // Reserve 15% for output
    summaryModel: 'openai/gpt-6-luna', // Model used for summarization
    windowSize: 10, // Messages to keep in sliding window
  },
});
```

Four strategies are available:

| Strategy         | Description                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `truncate`       | Drops the oldest messages beyond the limit                                                          |
| `sliding-window` | Keeps the last `windowSize` messages and replaces older ones with a summary                         |
| `summarize`      | Summarizes older messages using an LLM                                                              |
| `hybrid`         | Default. Sliding window for small overflows, LLM summary for larger ones, truncate as a last resort |

The runtime applies compression during `cog.run()` when the context approaches the model's limit. See [Context Management](https://cogitator.app/docs/advanced/context-management).

---

## Retry and Error Handling

Agent runs retry failed LLM calls themselves: errors flagged `retryable` (429, 5xx, connection failures) get 2 retries with exponential backoff by default, honouring the provider's `Retry-After`; streams are retried only before their first chunk. Tune it or turn it off on the runtime:

```typescript
const cog = new Cogitator({
  llm: {
    defaultModel: 'openai/gpt-6.1-sol',
    retry: {
      maxRetries: 4,
      baseDelay: 1000,
      maxDelay: 30_000,
      maxRetryAfter: 60_000, // a longer Retry-After fails the call at once
      requestTimeout: 180_000, // a call with no answer by then is aborted and retried
      onRetry: (event) => console.warn('LLM retry', event),
    },
    // retry: false,
  },
});
```

For your own unreliable operations, use the retry utilities:

```typescript
import { withRetry, retryable } from '@cogitator-ai/core';

const result = await withRetry(() => fetchFromAPI(), {
  maxRetries: 5,
  baseDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential', // 'exponential' | 'linear' | 'constant'
  jitter: 0.1,
  retryIf: (error) => error.message.includes('ECONNRESET'), // default: retryable errors only
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

### Prompt Caching

Prompt caching is on by default: Anthropic requests mark their stable prompt prefix for caching, and cache hits of every provider lower the run's cost (`usage.cachedInputTokens`, `usage.cacheWriteTokens`). Set `llm.promptCache: { ttl: '1h' }` for a longer Anthropic cache (default `'5m'`), or `llm.promptCache: false` to turn it off.

---

## Human-in-the-Loop

### Tool Approval

Tools can require approval before execution via `requiresApproval`:

```typescript
import fs from 'fs/promises';

const deleteTool = tool({
  name: 'delete_file',
  description: 'Delete a file from the filesystem',
  parameters: z.object({ path: z.string() }),
  requiresApproval: true, // Always require approval
  sideEffects: ['filesystem'],
  execute: async ({ path }) => {
    await fs.unlink(path);
    return { deleted: path };
  },
});

// Or conditionally based on params
const shellTool = tool({
  name: 'shell',
  description: 'Execute a shell command',
  parameters: z.object({ command: z.string() }),
  requiresApproval: ({ command }) => command.includes('rm') || command.includes('sudo'),
  execute: async ({ command }) => runShell(command),
});
```

When the model calls such a tool, the run **pauses**: it returns with `status: 'paused'`, the waiting calls in `pendingApprovals` and a `checkpoint`. Nothing of the paused turn has run. Continue it with a decision per call:

```typescript
const result = await cog.run(agent, { input: 'Clean up the temp files', threadId, userId });

if (result.status === 'paused') {
  for (const call of result.pendingApprovals!) {
    console.log(`${call.toolName}(${JSON.stringify(call.arguments)}) needs approval`);
  }

  const done = await cog.resume(agent, threadId, {
    userId,
    decisions: {
      [result.pendingApprovals![0].toolCallId]: { approved: true },
      // or { approved: false, reason: 'not now' }
    },
    // defaultDecision: { approved: true }, // for every call without a decision
  });
}
```

`cog.resume()` takes the thread id (the runtime keeps paused runs in the thread's memory, or in process memory without one, or in your `runCheckpoints` store) or the `result.checkpoint` itself. Calls left without a decision pause the run again.

To decide while the run waits — a CLI prompt, a confirm dialog — use `onApproval`; return `'pause'` to fall back to pausing:

```typescript
await cog.run(agent, {
  input,
  onApproval: async (call) => {
    const ok = await confirm(`Run ${call.toolName}?`);
    return ok ? { approved: true } : { approved: false, reason: 'declined in the CLI' };
  },
});
```

Without `onApproval`, `guardrails.onToolApproval` decides when it is set (`(toolName, args, sideEffects) => Promise<boolean>`); otherwise the run pauses. See [Tool Approvals](https://cogitator.app/docs/tools/approvals).

### Workflow Approval Nodes

For approvals inside multi-step workflows, use the human nodes of `@cogitator-ai/workflows`:

```typescript
import {
  WorkflowBuilder,
  approvalNode,
  humanWorkflowNode,
  InMemoryApprovalStore,
} from '@cogitator-ai/workflows';

type ContentState = { content: string; approved?: boolean };

const approvalStore = new InMemoryApprovalStore();

const workflow = new WorkflowBuilder<ContentState>('publish')
  .initialState({ content: '' })
  .addNode('generate', async () => ({ state: { content: 'Generated content' } }))
  .addNode(
    'review',
    humanWorkflowNode(
      approvalNode<ContentState>('review', {
        title: 'Review generated content',
        assignee: 'editor',
        timeout: 60_000,
        timeoutAction: 'reject',
      }),
      { approvalStore, stateMapper: (result) => ({ approved: result.approved }) }
    ),
    { after: ['generate'] }
  )
  .build();
```

See [Human-in-the-Loop Nodes](https://cogitator.app/docs/workflows/nodes#human-in-the-loop-nodes).

---

## Prompt Versions

`cog.prompts` keeps versions of an agent's instructions on top of the ones in code: deploy a new version and every following run uses it, roll back in one call, or A/B test instructions on live traffic. Versions are kept per agent `id` when set, else per `name`.

```typescript
await cog.prompts.deploy(writer, 'You write release notes. Lead with what changed for the user.');

const result = await cog.run(writer, { input });
result.prompt; // { key: 'writer', versionId, version: 2 }

await cog.prompts.rollbackTo(writer);
await cog.prompts.startABTest(writer, {
  name: 'shorter notes',
  treatment: 'You write release notes in at most five bullet points.',
  treatmentAllocation: 0.3,
});
```

Stores, scoring and auto-deploying winners are configured with `new Cogitator({ prompts: { ... } })`. See [Prompt Versions](https://cogitator.app/docs/advanced/prompt-versions).

---

## Security

```typescript
const cog = new Cogitator({
  security: {
    promptInjection: { action: 'block', threshold: 0.7 },
    pii: { mode: 'mask' }, // 'mask' | 'redact' | 'block'
  },
});
```

`security.pii` keeps personal data and secrets (emails, phone numbers, card numbers, IBANs, SSNs, IP addresses, API keys, plus your own `custom` patterns) away from the model provider: before every LLM request they are replaced with placeholders such as `[EMAIL_1]`; in `mask` mode the answer and tool call arguments get the real values back. `security.promptInjection` checks each run's input and fails the run with `PROMPT_INJECTION_DETECTED`. Guardrails (`guardrails`) filter input, output and tool calls with Constitutional AI. See [Security](https://cogitator.app/docs/advanced/security).

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
    console.log(`Tool ${result.name} returned:`, result.error ?? result.result);
  },

  onHandoff: ({ from, to }) => {
    console.log(`Handed over from ${from} to ${to}`);
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

For production observability, `@cogitator-ai/core` ships Langfuse and OTLP exporters. They are not attached automatically; connect them to these callbacks:

```typescript
import { createOTLPExporter } from '@cogitator-ai/core';

const otlp = createOTLPExporter({ endpoint: 'http://localhost:4318/v1/traces' });
otlp.start();

let runId = '';
await cog.run(agent, {
  input: 'Hello',
  onRunStart: (data) => {
    runId = data.runId;
  },
  onSpan: (span) => otlp.exportSpan(runId, span),
});
```

See [Observability](https://cogitator.app/docs/deployment/observability) for the Langfuse exporter.
