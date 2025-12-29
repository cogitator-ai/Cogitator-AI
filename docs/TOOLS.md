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
│  │   Built-in Tools  │  Custom Tools  │  MCP Servers  │  Plugin Tools       │  │
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
import { tool } from '@cogitator/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Perform mathematical calculations. Supports basic arithmetic, trigonometry, and common functions.',
  parameters: z.object({
    expression: z.string().describe('Mathematical expression to evaluate, e.g., "2 + 2 * 3"'),
  }),
  execute: async ({ expression }) => {
    // Use mathjs for safe evaluation
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
    path: z.string()
      .describe('File path relative to workspace root'),
    content: z.string()
      .describe('File content'),
    encoding: z.enum(['utf-8', 'base64'])
      .default('utf-8')
      .describe('Content encoding'),
    overwrite: z.boolean()
      .default(false)
      .describe('Whether to overwrite existing file'),
  }),
  execute: async ({ path, content, encoding, overwrite }) => {
    const fullPath = join(workspaceRoot, path);

    if (!overwrite && await exists(fullPath)) {
      return { error: `File already exists: ${path}. Set overwrite: true to replace.` };
    }

    const buffer = encoding === 'base64'
      ? Buffer.from(content, 'base64')
      : content;

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

  // Declare side effects for auditing
  sideEffects: ['filesystem', 'network', 'process'],

  // Require human approval for dangerous commands
  requiresApproval: (params) => {
    const dangerous = ['rm', 'sudo', 'chmod', 'kill', 'reboot'];
    return dangerous.some(cmd => params.command.includes(cmd));
  },

  execute: async ({ command, cwd, timeout }) => {
    const { stdout, stderr, exitCode } = await execAsync(command, {
      cwd,
      timeout,
    });

    return {
      stdout: stdout.slice(0, 10000), // Limit output size
      stderr: stderr.slice(0, 10000),
      exitCode,
    };
  },
});
```

---

## Built-in Tools

### File Operations

```typescript
import {
  fileRead,
  fileWrite,
  fileDelete,
  fileList,
  fileSearch,
  fileMove,
} from '@cogitator/tools/filesystem';

// Read file
const content = await fileRead.execute({ path: './src/index.ts' });

// Write file
await fileWrite.execute({
  path: './output.json',
  content: JSON.stringify(data, null, 2),
});

// List directory
const files = await fileList.execute({
  path: './src',
  recursive: true,
  pattern: '*.ts',
});

// Search in files
const matches = await fileSearch.execute({
  path: './src',
  query: 'function.*async',
  regex: true,
});
```

### Web Operations

```typescript
import {
  webFetch,
  webSearch,
  webScreenshot,
} from '@cogitator/tools/web';

// Fetch URL
const page = await webFetch.execute({
  url: 'https://example.com',
  format: 'markdown', // or 'html', 'text'
});

// Search the web
const results = await webSearch.execute({
  query: 'TypeScript best practices 2024',
  limit: 10,
});

// Take screenshot
const screenshot = await webScreenshot.execute({
  url: 'https://example.com',
  format: 'png',
  fullPage: true,
});
```

### Code Execution

```typescript
import { codeInterpreter } from '@cogitator/tools/code';

// Execute Python code
const result = await codeInterpreter.execute({
  language: 'python',
  code: `
    import pandas as pd
    df = pd.DataFrame({'a': [1, 2, 3], 'b': [4, 5, 6]})
    print(df.describe())
  `,
});

// Execute JavaScript
const jsResult = await codeInterpreter.execute({
  language: 'javascript',
  code: `
    const data = [1, 2, 3, 4, 5];
    const sum = data.reduce((a, b) => a + b, 0);
    console.log('Sum:', sum);
  `,
});
```

### Database Operations

```typescript
import { sqlQuery, sqlExecute } from '@cogitator/tools/database';

// Query database
const users = await sqlQuery.execute({
  connection: 'postgres://localhost/app',
  query: 'SELECT * FROM users WHERE active = $1',
  params: [true],
});

// Execute mutation
await sqlExecute.execute({
  connection: 'postgres://localhost/app',
  query: 'UPDATE users SET last_login = NOW() WHERE id = $1',
  params: [userId],
});
```

---

## MCP Integration

### Connecting to MCP Servers

```typescript
import { mcpServer } from '@cogitator/tools/mcp';

// Connect to filesystem server
const fsTools = await mcpServer({
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem'],
  env: {
    ALLOWED_DIRECTORIES: '/workspace,/tmp',
  },
});

// Connect to database server
const dbTools = await mcpServer({
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-postgres'],
  env: {
    DATABASE_URL: process.env.DATABASE_URL,
  },
});

// Use in agent
const agent = new Agent({
  tools: [...fsTools, ...dbTools],
});
```

### Creating MCP-Compatible Servers

```typescript
import { MCPServer, MCPTool } from '@cogitator/tools/mcp';

const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
});

server.addTool({
  name: 'my_custom_tool',
  description: 'Does something useful',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string' },
    },
    required: ['input'],
  },
  handler: async (params) => {
    return { result: `Processed: ${params.input}` };
  },
});

// Start server
server.listen();
```

---

## Tool Registry

### Registering Tools

```typescript
import { ToolRegistry } from '@cogitator/core';

const registry = new ToolRegistry();

// Register individual tools
registry.register(calculator);
registry.register(fileRead);
registry.register(webSearch);

// Register tool groups
registry.registerGroup('filesystem', [fileRead, fileWrite, fileList]);
registry.registerGroup('web', [webFetch, webSearch, webScreenshot]);

// Register from MCP server
const mcpTools = await mcpServer('...');
registry.registerGroup('mcp-fs', mcpTools);
```

### Tool Discovery

```typescript
// Get all tools
const allTools = registry.getAll();

// Get by name
const calc = registry.get('calculator');

// Get by group
const webTools = registry.getGroup('web');

// Search tools
const searchResults = registry.search('file');
// Returns: [fileRead, fileWrite, fileList, fileSearch, ...]

// Get tool schema (for LLM)
const schema = registry.getSchema('calculator');
// { name: 'calculator', description: '...', parameters: {...} }
```

### Tool Permissions

```typescript
const registry = new ToolRegistry({
  permissions: {
    // Default permissions for all tools
    default: {
      maxExecutionsPerMinute: 100,
      requiresApproval: false,
    },

    // Per-tool overrides
    tools: {
      shell_execute: {
        maxExecutionsPerMinute: 10,
        requiresApproval: true,
        allowedPatterns: ['^ls', '^cat', '^git'],
        deniedPatterns: ['^rm', '^sudo'],
      },
      file_delete: {
        requiresApproval: true,
        allowedPaths: ['/workspace', '/tmp'],
      },
    },
  },
});
```

---

## Sandboxed Execution

### Docker Sandbox

```typescript
const tool = tool({
  name: 'run_python',
  parameters: z.object({
    code: z.string(),
  }),

  // Execute in Docker container
  sandbox: {
    type: 'docker',
    image: 'cogitator/sandbox:python3.11',
    resources: {
      memory: '512MB',
      cpuShares: 512,
      pidsLimit: 100,
    },
    network: {
      mode: 'none', // No network access
    },
    mounts: [
      { source: '/workspace', target: '/workspace', readOnly: true },
    ],
    timeout: 30_000,
  },

  execute: async ({ code }) => {
    // This runs inside the container
    return await execPython(code);
  },
});
```

### WASM Sandbox

```typescript
import { wasmSandbox } from '@cogitator/sandbox';

const tool = tool({
  name: 'run_wasm',
  parameters: z.object({
    module: z.string(), // WASM module path
    function: z.string(),
    args: z.array(z.any()),
  }),

  sandbox: {
    type: 'wasm',
    runtime: 'extism',
    memoryLimit: 64 * 1024 * 1024, // 64MB
    timeout: 5_000,
    allowedHosts: [], // No network
  },

  execute: async ({ module, func, args }) => {
    const instance = await wasmSandbox.instantiate(module);
    return instance.call(func, ...args);
  },
});
```

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

# Default command
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
  execute: async ({ topic, depth }, { tools }) => {
    // Use other tools
    const searchResults = await tools.webSearch.execute({
      query: topic,
      limit: depth === 'thorough' ? 10 : 3,
    });

    const contents = await Promise.all(
      searchResults.map(r => tools.webFetch.execute({ url: r.url }))
    );

    // Return combined result
    return {
      sources: searchResults.map(r => r.url),
      content: contents.map(c => c.content).join('\n\n'),
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

### Async Tools with Progress

```typescript
const longRunningTask = tool({
  name: 'long_running_task',
  description: 'A task that takes time to complete',
  parameters: z.object({
    data: z.string(),
  }),

  // Enable progress reporting
  supportsProgress: true,

  execute: async ({ data }, { progress }) => {
    const steps = ['Parsing', 'Processing', 'Validating', 'Saving'];

    for (let i = 0; i < steps.length; i++) {
      progress.report({
        current: i + 1,
        total: steps.length,
        message: steps[i],
      });

      await doStep(steps[i], data);
    }

    return { success: true };
  },
});
```

---

## Error Handling

### Tool Errors

```typescript
import { ToolError, ToolValidationError, ToolTimeoutError } from '@cogitator/core';

const safeTool = tool({
  name: 'safe_tool',
  parameters: z.object({ input: z.string() }),

  execute: async ({ input }) => {
    try {
      return await riskyOperation(input);
    } catch (error) {
      // Return error as result (agent can handle)
      if (error instanceof ValidationError) {
        return {
          error: true,
          type: 'validation',
          message: error.message,
          suggestion: 'Try a different input format',
        };
      }

      // Re-throw for fatal errors
      throw new ToolError('Operation failed', { cause: error });
    }
  },
});
```

### Retry Logic

```typescript
const resilientTool = tool({
  name: 'api_call',
  parameters: z.object({ endpoint: z.string() }),

  // Built-in retry
  retry: {
    maxRetries: 3,
    backoff: 'exponential',
    initialDelay: 1000,
    retryOn: (error) => {
      // Only retry on transient errors
      return error.status === 429 || error.status >= 500;
    },
  },

  execute: async ({ endpoint }) => {
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
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
//   { name: 'tool.web_fetch', duration: 800, attributes: { url: 'https://...' } },
// ]
```

### Custom Metrics

```typescript
import { metrics } from '@cogitator/observability';

const apiTool = tool({
  name: 'external_api',
  execute: async (params) => {
    const timer = metrics.timer('tool.external_api.duration');
    timer.start();

    try {
      const result = await callExternalAPI(params);
      metrics.increment('tool.external_api.success');
      return result;
    } catch (error) {
      metrics.increment('tool.external_api.failure');
      throw error;
    } finally {
      timer.stop();
    }
  },
});
```

---

## Tool Testing

```typescript
import { mockTool, ToolTestHarness } from '@cogitator/testing';

describe('Calculator Tool', () => {
  it('should evaluate expressions', async () => {
    const harness = new ToolTestHarness(calculator);

    const result = await harness.execute({ expression: '2 + 2 * 3' });

    expect(result.result).toBe(8);
  });

  it('should handle errors gracefully', async () => {
    const harness = new ToolTestHarness(calculator);

    const result = await harness.execute({ expression: 'invalid' });

    expect(result.error).toBeDefined();
  });
});

describe('Agent with Mocked Tools', () => {
  it('should use tools correctly', async () => {
    const mockSearch = mockTool('web_search')
      .whenCalledWith({ query: expect.stringContaining('TypeScript') })
      .returns([{ title: 'TS Guide', url: 'https://...' }]);

    const agent = new Agent({
      model: 'gpt-4o',
      tools: [mockSearch],
    });

    await agent.run('Find TypeScript resources');

    expect(mockSearch).toHaveBeenCalledWith({
      query: expect.stringContaining('TypeScript'),
    });
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
  if (!await exists(filePath)) {
    const dir = dirname(filePath);
    const similar = await findSimilar(dir, basename(filePath));

    return {
      error: `File not found: ${filePath}`,
      suggestion: similar.length > 0
        ? `Did you mean: ${similar.join(', ')}?`
        : `Directory contents: ${await listDir(dir)}`,
    };
  }
  // ...
}
```

### 3. Resource Limits

```typescript
tool({
  name: 'process_data',
  parameters: z.object({
    data: z.string().max(1_000_000), // 1MB limit
  }),
  timeout: 30_000, // 30 second timeout
  sandbox: {
    memory: '256MB',
    cpu: 0.5,
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
    // Safe to call multiple times
  },
});
```
