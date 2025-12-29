# Agents

> Patterns, configuration, and best practices for building agents

## Overview

An Agent in Cogitator is a configured LLM instance with:

- **Model** — The underlying LLM (Llama, GPT-4, Claude, etc.)
- **Instructions** — System prompt defining behavior
- **Tools** — Capabilities the agent can use
- **Memory** — Persistent context across conversations

```typescript
interface Agent {
  // Identity
  id: string;
  name: string;
  description?: string;

  // Model configuration
  model: string; // 'ollama/llama3.2:70b', 'openai/gpt-4o'
  temperature?: number; // 0-2, default 0.7
  topP?: number; // 0-1, default 1
  maxTokens?: number; // Max output tokens

  // Behavior
  instructions: string; // System prompt
  tools: Tool[]; // Available tools
  responseFormat?: ResponseFormat; // Structured output

  // Memory
  memory: MemoryConfig;

  // Execution
  maxIterations?: number; // Max tool use loops, default 10
  timeout?: number; // Max execution time in ms

  // Sandbox (for code execution)
  sandbox?: SandboxConfig;
}
```

---

## Creating Agents

### Basic Agent

```typescript
import { Agent } from '@cogitator/core';

const assistant = new Agent({
  name: 'assistant',
  model: 'llama3.2:latest',
  instructions: `You are a helpful assistant. Answer questions clearly and concisely.
                 If you don't know something, say so.`,
});
```

### Agent with Tools

```typescript
import { Agent, tool } from '@cogitator/core';
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
  model: 'gpt-4o',
  instructions: `You are a research assistant. Use your tools to find accurate,
                 up-to-date information. Always cite your sources.`,
  tools: [searchWeb, readUrl],
});
```

### Agent with Structured Output

```typescript
const analyzer = new Agent({
  name: 'analyzer',
  model: 'claude-3-5-sonnet',
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

```typescript
const personalAssistant = new Agent({
  name: 'personal-assistant',
  model: 'gpt-4o',
  instructions: `You are a personal assistant. Remember user preferences
                 and context from previous conversations.`,
  memory: {
    shortTerm: 'redis',
    longTerm: 'postgres',
    semantic: 'pgvector',
    summarization: {
      enabled: true,
      threshold: 50_000,
    },
  },
});
```

---

## Agent Patterns

### 1. Planner Agent

Breaks down complex tasks into subtasks.

```typescript
const planner = new Agent({
  name: 'planner',
  model: 'gpt-4o',
  temperature: 0.2, // Low for consistent planning
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
  model: 'claude-3-5-sonnet',
  instructions: `You are a task execution agent. Execute the given task precisely.
                 Use tools when needed. Report success or failure clearly.`,
  tools: [fileRead, fileWrite, shellExecute, webSearch],
  maxIterations: 20,
  sandbox: {
    type: 'docker',
    image: 'cogitator/sandbox:node20',
    resources: { memory: '512MB', cpu: 1 },
  },
});
```

### 3. Critic Agent

Reviews and validates work.

```typescript
const critic = new Agent({
  name: 'critic',
  model: 'gpt-4o',
  temperature: 0.1, // Very low for consistent criticism
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
  model: 'gpt-4o-mini', // Fast model for routing
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
  model: 'claude-3-5-sonnet',
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

```typescript
// Local models (via Ollama)
model: 'ollama/llama3.2:latest';
model: 'ollama/codellama:34b';
model: 'ollama/mistral:7b-instruct';

// OpenAI
model: 'openai/gpt-4o';
model: 'openai/gpt-4o-mini';
model: 'openai/o1-preview';

// Anthropic
model: 'anthropic/claude-3-5-sonnet';
model: 'anthropic/claude-3-opus';

// Google
model: 'google/gemini-pro';
model: 'google/gemini-ultra';

// vLLM (self-hosted)
model: 'vllm/meta-llama/Llama-3.2-70B-Instruct';
```

### Temperature Guidelines

| Use Case          | Temperature | Reasoning                   |
| ----------------- | ----------- | --------------------------- |
| Code generation   | 0.0 - 0.2   | Deterministic, correct code |
| Planning          | 0.2 - 0.4   | Consistent but flexible     |
| General assistant | 0.5 - 0.7   | Balanced                    |
| Creative writing  | 0.8 - 1.2   | More varied output          |
| Brainstorming     | 1.0 - 1.5   | Maximum creativity          |

### Context Window Management

```typescript
const agent = new Agent({
  model: 'gpt-4o',
  // Model has 128k context, but limit to 32k for cost/speed
  contextWindow: 32_000,

  // When context exceeds limit, summarize old messages
  memory: {
    summarization: {
      enabled: true,
      threshold: 30_000, // Start summarizing at 30k
      strategy: 'hierarchical',
    },
  },
});
```

---

## Tool Integration

### Built-in Tools

```typescript
import {
  fileRead,
  fileWrite,
  shellExecute,
  webSearch,
  webFetch,
  calculator,
  codeInterpreter,
} from '@cogitator/tools';

const agent = new Agent({
  tools: [fileRead, fileWrite, shellExecute],
});
```

### Custom Tools

```typescript
import { tool } from '@cogitator/core';
import { z } from 'zod';

const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email to a recipient',
  parameters: z.object({
    to: z.string().email(),
    subject: z.string().max(100),
    body: z.string(),
    attachments: z.array(z.string()).optional(),
  }),
  // Type-safe execution
  execute: async ({ to, subject, body, attachments }) => {
    const result = await emailService.send({ to, subject, body, attachments });
    return { messageId: result.id, sent: true };
  },
});
```

### MCP Tool Servers

```typescript
import { mcpServer } from '@cogitator/tools';

// Connect to MCP servers
const filesystemTools = await mcpServer('npx -y @anthropic/mcp-server-filesystem');
const browserTools = await mcpServer('npx -y @anthropic/mcp-server-puppeteer');
const databaseTools = await mcpServer('npx -y @anthropic/mcp-server-postgres');

const agent = new Agent({
  tools: [...filesystemTools, ...browserTools, ...databaseTools],
});
```

---

## Execution Control

### Iteration Limits

```typescript
const agent = new Agent({
  maxIterations: 20, // Max tool use loops

  // Per-iteration timeout
  iterationTimeout: 30_000, // 30 seconds per iteration

  // Total execution timeout
  timeout: 300_000, // 5 minutes total
});
```

### Error Handling

```typescript
const agent = new Agent({
  // Retry failed tool calls
  toolRetry: {
    maxRetries: 3,
    backoff: 'exponential',
    initialDelay: 1000,
  },

  // On unrecoverable error
  onError: 'fail', // 'fail' | 'continue' | 'human-in-loop'
});
```

### Human-in-the-Loop

```typescript
const agent = new Agent({
  // Require human approval for certain actions
  humanApproval: {
    required: ['send_email', 'delete_file', 'execute_shell'],
    timeout: 300_000, // 5 minutes to approve
    defaultAction: 'reject', // If timeout
  },
});

// When agent needs approval
cog.on('approval_required', async (event) => {
  console.log(`Agent wants to: ${event.action}`);
  console.log(`Parameters: ${JSON.stringify(event.params)}`);

  // Get human decision
  const approved = await askHuman(event);
  event.respond(approved);
});
```

---

## Agent Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ CREATED  │────►│  READY   │────►│ RUNNING  │────►│COMPLETED │
└──────────┘     └──────────┘     └────┬─────┘     └──────────┘
                      ▲                │
                      │                │
                      │           ┌────▼─────┐
                      │           │ WAITING  │ (for tool/human)
                      │           └────┬─────┘
                      │                │
                      └────────────────┘

                           │
                           ▼
                      ┌──────────┐
                      │  FAILED  │
                      └──────────┘
```

### Lifecycle Hooks

```typescript
const agent = new Agent({
  hooks: {
    onStart: async (context) => {
      console.log('Agent starting:', context.input);
      // Load additional context, validate input, etc.
    },

    beforeLLM: async (messages) => {
      // Modify messages before sending to LLM
      return messages;
    },

    afterLLM: async (response) => {
      // Process LLM response
      logTokenUsage(response.usage);
      return response;
    },

    beforeTool: async (toolCall) => {
      // Validate or modify tool calls
      console.log(`Calling tool: ${toolCall.name}`);
      return toolCall;
    },

    afterTool: async (result) => {
      // Process tool results
      return result;
    },

    onComplete: async (result) => {
      console.log('Agent completed:', result.output);
      // Cleanup, logging, etc.
    },

    onError: async (error) => {
      console.error('Agent failed:', error);
      // Error handling, alerting, etc.
    },
  },
});
```

---

## Serialization

Agents can be saved and loaded as configuration files.

### Export to YAML

```yaml
# agents/researcher.yaml
name: researcher
model: gpt-4o
temperature: 0.3

instructions: |
  You are a research assistant. Use your tools to find accurate,
  up-to-date information. Always cite your sources with URLs.

tools:
  - search_web
  - read_url

memory:
  shortTerm: redis
  longTerm: postgres
  semantic: pgvector

maxIterations: 15
timeout: 180000
```

### Load from YAML

```typescript
import { loadAgent } from '@cogitator/core';

const researcher = await loadAgent('./agents/researcher.yaml');
```

---

## Testing Agents

### Unit Testing

```typescript
import { Agent, MockLLM, MockTool } from '@cogitator/testing';

describe('Researcher Agent', () => {
  it('should search and summarize results', async () => {
    const mockLLM = new MockLLM()
      .onMessage('Find information about WebGPU')
      .respondWith({
        content: '',
        toolCalls: [{ name: 'search_web', arguments: { query: 'WebGPU' } }],
      })
      .onToolResult()
      .respondWith({ content: 'WebGPU is a new graphics API...' });

    const mockSearch = new MockTool('search_web')
      .onCall({ query: 'WebGPU' })
      .return([{ title: 'WebGPU Spec', url: 'https://...' }]);

    const agent = new Agent({
      name: 'test-researcher',
      model: mockLLM,
      tools: [mockSearch],
    });

    const result = await agent.run('Find information about WebGPU');

    expect(result.output).toContain('WebGPU');
    expect(mockSearch.callCount).toBe(1);
  });
});
```

### Integration Testing

```typescript
import { Cogitator } from '@cogitator/core';

describe('Agent Integration', () => {
  let cog: Cogitator;

  beforeAll(async () => {
    cog = new Cogitator({
      llm: { provider: 'ollama', model: 'llama3.2:latest' },
    });
  });

  it('should complete a real task', async () => {
    const agent = new Agent({
      name: 'test-agent',
      model: 'llama3.2:latest',
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

```typescript
import { evaluate, EvalDataset } from '@cogitator/eval';

const dataset: EvalDataset = [
  {
    input: 'Calculate the factorial of 5',
    expected: '120',
    criteria: ['contains_answer', 'mathematically_correct'],
  },
  {
    input: 'What is the capital of France?',
    expected: 'Paris',
    criteria: ['exact_match'],
  },
];

const results = await evaluate(agent, dataset);

console.log(results.summary);
// { accuracy: 0.95, avgLatency: 1.2, criteria: { contains_answer: 1.0, exact_match: 0.9 } }
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
  model: 'gpt-4o-mini', // Fast, cheap
  // ...
});

// Use powerful models for complex reasoning
const architect = new Agent({
  model: 'claude-3-opus', // Best reasoning
  // ...
});
```

### 3. Tool Design

```typescript
// Bad: Vague tool
tool({
  name: 'do_stuff',
  description: 'Does various things',
  // ...
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
  // ...
});
```

### 4. Error Messages

```typescript
// Provide helpful error messages
tool({
  name: 'read_file',
  execute: async ({ path }) => {
    try {
      return await fs.readFile(path, 'utf-8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          error: `File not found: ${path}. Available files: ${await listDir(dirname(path))}`,
        };
      }
      throw error;
    }
  },
});
```

### 5. Resource Limits

```typescript
// Always set limits
const agent = new Agent({
  maxIterations: 20,
  timeout: 300_000,
  sandbox: {
    resources: {
      memory: '512MB',
      cpu: 1,
      timeout: '30s',
    },
  },
});
```
