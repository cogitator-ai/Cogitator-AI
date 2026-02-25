# Tools

> Building, using, and managing agent capabilities

## Overview

Tools give agents the ability to interact with the outside world. In Cogitator, tools are:

- **Type-safe** — Parameters validated with Zod schemas
- **Sandboxed** — Execute in isolated environments (Docker/WASM)
- **MCP-compatible** — Work with Model Context Protocol servers
- **Observable** — Full tracing and cost tracking

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Tool System                                         │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                          Tool Registry                                    │  │
│  │                                                                           │  │
│  │   Built-in Tools  │  Custom Tools  │  MCP Servers  │  WASM Tools         │  │
│  │                                                                           │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                          │
│                                      ▼                                          │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                         Execution Layer                                   │  │
│  │                                                                           │  │
│  │   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   │  │
│  │   │   Native    │   │   Docker    │   │    WASM     │   │   Remote    │   │  │
│  │   │  Executor   │   │  Sandbox    │   │   Sandbox   │   │  Executor   │   │  │
│  │   └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘   │  │
│  │                                                                           │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Creating Tools

### Basic Tool

```typescript
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description:
    'Perform mathematical calculations. Supports basic arithmetic, trigonometry, and common functions.',
  parameters: z.object({
    expression: z.string().describe('Mathematical expression to evaluate, e.g., "2 + 2 * 3"'),
  }),
  execute: async ({ expression }) => {
    const result = math.evaluate(expression);
    return { result, expression };
  },
});
```

### Tool with Complex Schema

```typescript
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

    if (!overwrite && (await exists(fullPath))) {
      return { error: `File already exists: ${path}. Set overwrite: true to replace.` };
    }

    const buffer = encoding === 'base64' ? Buffer.from(content, 'base64') : content;

    await fs.writeFile(fullPath, buffer);

    return {
      success: true,
      path,
      size: Buffer.byteLength(buffer),
    };
  },
});
```

### Tool with Side Effects Tracking

```typescript
const shellExecute = tool({
  name: 'shell_execute',
  description: 'Execute a shell command',
  parameters: z.object({
    command: z.string().describe('Command to execute'),
    cwd: z.string().optional().describe('Working directory'),
    timeout: z.number().default(30000).describe('Timeout in milliseconds'),
  }),

  sideEffects: ['filesystem', 'network', 'process'],

  requiresApproval: (params) => {
    const dangerous = ['rm', 'sudo', 'chmod', 'kill', 'reboot'];
    return dangerous.some((cmd) => params.command.includes(cmd));
  },

  execute: async ({ command, cwd, timeout }) => {
    const { stdout, stderr, exitCode } = await execAsync(command, {
      cwd,
      timeout,
    });

    return {
      stdout: stdout.slice(0, 10000),
      stderr: stderr.slice(0, 10000),
      exitCode,
    };
  },
});
```

---

## Built-in Tools

All built-in tools are exported directly from `@cogitator-ai/core`.

### File Operations

```typescript
import { fileRead, fileWrite, fileDelete, fileList, fileExists } from '@cogitator-ai/core';

const agent = new Agent({
  tools: [fileRead, fileWrite, fileList, fileExists, fileDelete],
});
```

Available file tools: `fileRead`, `fileWrite`, `fileList`, `fileExists`, `fileDelete`.

### Web Operations

```typescript
import { webSearch, webScrape } from '@cogitator-ai/core';

const agent = new Agent({
  tools: [webSearch, webScrape],
});
```

### HTTP & System

```typescript
import { httpRequest, exec, sqlQuery } from '@cogitator-ai/core';

const agent = new Agent({
  tools: [httpRequest, exec, sqlQuery],
});
```

### All Built-in Tools

```typescript
import { builtinTools } from '@cogitator-ai/core';

const agent = new Agent({ tools: [...builtinTools] });
```

`builtinTools` includes: `calculator`, `datetime`, `uuid`, `randomNumber`, `randomString`, `hash`, `base64Encode`, `base64Decode`, `sleep`, `jsonParse`, `jsonStringify`, `regexMatch`, `regexReplace`, `fileRead`, `fileWrite`, `fileList`, `fileExists`, `fileDelete`, `httpRequest`, `exec`, `webSearch`, `webScrape`, `sqlQuery`, `vectorSearch`, `sendEmail`, `githubApi`.

---

## MCP Integration

### Connecting to MCP Servers

```typescript
import { MCPClient, connectMCPServer } from '@cogitator-ai/mcp';

// Connect and get tools in one step
const { tools, cleanup } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/workspace'],
});

const agent = new Agent({ tools });

// When done
await cleanup();
```

### Manual Client Usage

```typescript
import { MCPClient } from '@cogitator-ai/mcp';

// Connect to filesystem server
const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/workspace'],
});

// Get available tools as Cogitator tools
const fsTools = await client.getTools();

// Connect to another server
const dbClient = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-postgres'],
  env: { DATABASE_URL: process.env.DATABASE_URL },
});

const dbTools = await dbClient.getTools();

// Use in agent
const agent = new Agent({
  tools: [...fsTools, ...dbTools],
});

// Clean up
await client.close();
await dbClient.close();
```

### Creating MCP-Compatible Servers

```typescript
import { MCPServer } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const myCustomTool = tool({
  name: 'my_custom_tool',
  description: 'Does something useful',
  parameters: z.object({
    input: z.string(),
  }),
  execute: async ({ input }) => {
    return { result: `Processed: ${input}` };
  },
});

const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
  transport: 'stdio',
});

server.registerTool(myCustomTool);

// Start server
await server.start();
```

### Expose Multiple Tools as MCP Server

```typescript
import { MCPServer, serveMCPTools } from '@cogitator-ai/mcp';
import { calculator, webSearch } from '@cogitator-ai/core';

// Shorthand helper
await serveMCPTools([calculator, webSearch], {
  name: 'cogitator-tools',
  version: '1.0.0',
  transport: 'stdio',
});
```

---

## Tool Registry

### Registering Tools

```typescript
import { ToolRegistry } from '@cogitator-ai/core';

const registry = new ToolRegistry();

// Register individual tools
registry.register(calculator);
registry.register(fileRead);
registry.register(webSearch);

// Register multiple at once
registry.registerMany([fileRead, fileWrite, fileList]);
```

### Tool Discovery

```typescript
// Get all tools
const allTools = registry.getAll();

// Get by name
const calc = registry.get('calculator');

// Check existence
const exists = registry.has('calculator');

// Get all names
const names = registry.getNames();

// Get JSON schemas (for LLM function calling)
const schemas = registry.getSchemas();
// [{ name: 'calculator', description: '...', parameters: {...} }, ...]
```

---

## Sandboxed Execution

### Docker Sandbox

```typescript
const runPython = tool({
  name: 'run_python',
  parameters: z.object({
    code: z.string(),
  }),

  sandbox: {
    type: 'docker',
    image: 'cogitator/sandbox:python3.11',
    resources: {
      memory: '512MB',
      cpuShares: 512,
      pidsLimit: 100,
    },
    network: {
      mode: 'none',
    },
    mounts: [{ source: '/workspace', target: '/workspace', readOnly: true }],
    timeout: 30_000,
  },

  execute: async ({ code }) => {
    return await execPython(code);
  },
});
```

### WASM Sandbox

Use `@cogitator-ai/wasm-tools` for WASM-based execution:

```typescript
import { defineWasmTool } from '@cogitator-ai/wasm-tools';
import { z } from 'zod';

const myWasmTool = defineWasmTool({
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
  tools: [createCalcTool(), createHashTool(), createBase64Tool(), createCsvTool()],
});
```

14 pre-built WASM tools: `calc`, `hash`, `base64`, `json`, `slug`, `validation`, `diff`, `regex`, `csv`, `markdown`, `xml`, `datetime`, `compression`, `signing`.

### Sandbox Images

```dockerfile
# cogitator/sandbox:python3.11
FROM python:3.11-slim

# Install common packages
RUN pip install --no-cache-dir \
    numpy pandas scipy matplotlib \
    scikit-learn requests beautifulsoup4

# Security: Run as non-root
RUN useradd -m sandbox
USER sandbox
WORKDIR /workspace

CMD ["python", "-c", "print('Sandbox ready')"]
```

```dockerfile
# cogitator/sandbox:node20
FROM node:20-alpine

# Install common packages
RUN npm install -g typescript tsx

# Security: Run as non-root
USER node
WORKDIR /workspace

CMD ["node", "--version"]
```

---

## Tool Patterns

### Compound Tools

Tools that compose other tools:

```typescript
const researchAndSummarize = tool({
  name: 'research_and_summarize',
  description: 'Search the web and summarize findings',
  parameters: z.object({
    topic: z.string(),
    depth: z.enum(['quick', 'thorough']).default('quick'),
  }),
  execute: async ({ topic, depth }, context) => {
    const searchResults = await webSearch.execute({ query: topic }, context);

    return {
      topic,
      results: searchResults,
    };
  },
});
```

### Stateful Tools

Tools that maintain state across calls:

```typescript
class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  readonly tools = {
    browser_open: tool({
      name: 'browser_open',
      description: 'Open a browser and navigate to URL',
      parameters: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        this.browser = await puppeteer.launch();
        this.page = await this.browser.newPage();
        await this.page.goto(url);
        return { success: true, title: await this.page.title() };
      },
    }),

    browser_click: tool({
      name: 'browser_click',
      description: 'Click an element on the page',
      parameters: z.object({ selector: z.string() }),
      execute: async ({ selector }) => {
        if (!this.page) throw new Error('Browser not open');
        await this.page.click(selector);
        return { success: true };
      },
    }),

    browser_screenshot: tool({
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page',
      parameters: z.object({}),
      execute: async () => {
        if (!this.page) throw new Error('Browser not open');
        const screenshot = await this.page.screenshot({ encoding: 'base64' });
        return { image: screenshot };
      },
    }),

    browser_close: tool({
      name: 'browser_close',
      description: 'Close the browser',
      parameters: z.object({}),
      execute: async () => {
        await this.browser?.close();
        this.browser = null;
        this.page = null;
        return { success: true };
      },
    }),
  };
}
```

---

## Error Handling

### Tool Errors

Tools should return error objects rather than throwing when the agent can recover:

```typescript
const safeTool = tool({
  name: 'safe_tool',
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

### Tool Tracing

```typescript
// Every tool call is automatically traced
const result = await agent.run('Search for TypeScript tutorials');

console.log(result.trace.spans);
// [
//   { name: 'tool.web_search', duration: 1200, attributes: { query: 'TypeScript tutorials' } },
//   { name: 'tool.web_scrape', duration: 800, attributes: { url: 'https://...' } },
// ]
```

---

## Tool Testing

Use `@cogitator-ai/test-utils` for mocking LLM backends in agent tests:

```typescript
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { Cogitator, Agent } from '@cogitator-ai/core';

describe('Agent with Tools', () => {
  it('should call tools', async () => {
    const mockBackend = new MockLLMBackend();
    mockBackend.addResponse({
      role: 'assistant',
      content: 'The answer is 42',
    });

    const cog = new Cogitator({
      llm: { defaultModel: 'mock/test' },
    });

    const agent = new Agent({
      name: 'test-agent',
      tools: [calculator],
    });

    const result = await cog.run(agent, { input: 'Calculate 6 * 7' });
    expect(result.output).toBeDefined();
  });
});
```

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
  parameters: z.object({
    data: z.string().max(1_000_000), // 1MB limit
  }),
  timeout: 30_000,
  sandbox: {
    type: 'docker',
    image: 'alpine:latest',
    resources: {
      memory: '256MB',
      cpus: 0.5,
    },
  },
  // ...
});
```

### 4. Idempotency

```typescript
// Make tools idempotent when possible
tool({
  name: 'ensure_directory',
  description: 'Ensure a directory exists (creates if needed)',
  execute: async ({ path }) => {
    await fs.mkdir(path, { recursive: true });
    return { exists: true, path };
  },
});
```
