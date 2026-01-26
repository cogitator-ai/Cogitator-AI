# @cogitator-ai/mcp

MCP (Model Context Protocol) integration for Cogitator. Connect to external MCP servers or expose Cogitator tools as an MCP server.

## Installation

```bash
pnpm add @cogitator-ai/mcp
```

## Features

- **MCP Client** - Connect to any MCP server (stdio, HTTP, SSE)
- **MCP Server** - Expose Cogitator tools as MCP endpoints
- **Tool Adapters** - Bidirectional conversion between Cogitator and MCP formats
- **Schema Converters** - Convert between Zod and JSON Schema
- **Resources & Prompts** - Access MCP resources and prompt templates
- **Transport Flexibility** - Support for stdio, HTTP, and SSE transports
- **Retry & Recovery** - Automatic retry with exponential backoff and reconnection handling

---

## Quick Start

### Use Tools from an MCP Server

```typescript
import { MCPClient } from '@cogitator-ai/mcp';
import { Agent, Cogitator } from '@cogitator-ai/core';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/allowed/path'],
});

const tools = await client.getTools();

const agent = new Agent({
  name: 'File Agent',
  model: 'ollama/llama3.1:8b',
  instructions: 'You can read and write files.',
  tools,
});

const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'List files in /allowed/path',
});

await client.close();
await cog.close();
```

### Expose Cogitator Tools as MCP Server

```typescript
import { MCPServer } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Perform math calculations',
  parameters: z.object({
    expression: z.string().describe('Math expression'),
  }),
  execute: async ({ expression }) => {
    return String(eval(expression));
  },
});

const server = new MCPServer({
  name: 'my-tools',
  version: '1.0.0',
  transport: 'stdio',
});

server.registerTool(calculator);
await server.start();
```

---

## MCP Client

Connect to external MCP servers and use their tools with Cogitator agents.

### Connection Options

```typescript
import { MCPClient } from '@cogitator-ai/mcp';

const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/path'],
  env: { DEBUG: 'true' },
  timeout: 30000,
  clientName: 'my-app',
  clientVersion: '1.0.0',
});
```

### Configuration

```typescript
interface MCPClientConfig {
  transport: 'stdio' | 'http' | 'sse';

  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // For HTTP/SSE transport
  url?: string;

  // Connection options
  timeout?: number;
  clientName?: string;
  clientVersion?: string;

  // Retry configuration
  retry?: MCPRetryConfig;
  autoReconnect?: boolean;

  // Reconnection callbacks
  onReconnecting?: (attempt: number) => void;
  onReconnected?: () => void;
  onReconnectFailed?: (error: Error) => void;
}
```

### Retry & Recovery

The MCP client includes automatic retry and reconnection handling for resilient connections.

```typescript
const client = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/path'],

  retry: {
    maxRetries: 5,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryOnConnectionLoss: true,
  },

  autoReconnect: true,
  onReconnecting: (attempt) => console.log(`Reconnecting... attempt ${attempt}`),
  onReconnected: () => console.log('Reconnected successfully'),
  onReconnectFailed: (error) => console.error('Failed to reconnect:', error),
});
```

#### Retry Configuration

```typescript
interface MCPRetryConfig {
  maxRetries?: number; // Default: 3
  initialDelay?: number; // Default: 1000ms
  maxDelay?: number; // Default: 30000ms
  backoffMultiplier?: number; // Default: 2
  retryOnConnectionLoss?: boolean; // Default: true
}
```

#### Automatic Retry Behavior

All MCP operations (`callTool`, `listResources`, `readResource`, `listPrompts`, `getPrompt`) automatically retry on:

- Connection errors (ECONNREFUSED, ECONNRESET, etc.)
- Timeout errors
- Network failures

When a connection error is detected with `autoReconnect: true`, the client will:

1. Close the existing connection
2. Create a new transport and client
3. Reconnect with exponential backoff
4. Continue the operation on the new connection

#### Manual Reconnection

```typescript
if (!client.isConnected()) {
  await client.reconnect();
}
```

### Transport Types

| Transport | Use Case                                     |
| --------- | -------------------------------------------- |
| `stdio`   | Local MCP servers spawned as child processes |
| `http`    | Remote MCP servers over HTTP                 |
| `sse`     | Server-Sent Events for streaming             |

### Client Methods

```typescript
const client = await MCPClient.connect(config);

client.isConnected();

client.isReconnecting();

client.getCapabilities();

await client.reconnect();

const definitions = await client.listToolDefinitions();

const tools = await client.getTools();

const result = await client.callTool('tool_name', { arg: 'value' });

const resources = await client.listResources();

const content = await client.readResource('file://path/to/file');

const prompts = await client.listPrompts();

const messages = await client.getPrompt('prompt_name', { arg: 'value' });

await client.close();
```

### Helper Function

For quick one-liner connections:

```typescript
import { connectMCPServer } from '@cogitator-ai/mcp';

const { tools, client, cleanup } = await connectMCPServer({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/path'],
});

const agent = new Agent({
  tools,
  // ...
});

// When done
await cleanup();
```

---

## MCP Server

Expose Cogitator tools as an MCP server for use by Claude Desktop, other AI assistants, or any MCP client.

### Creating a Server

```typescript
import { MCPServer } from '@cogitator-ai/mcp';

const server = new MCPServer({
  name: 'my-cogitator-server',
  version: '1.0.0',
  transport: 'stdio',
  logging: true,
});

server.registerTool(tool1);
server.registerTool(tool2);
// or
server.registerTools([tool1, tool2, tool3]);

await server.start();
```

### Server Configuration

```typescript
interface MCPServerConfig {
  name: string;
  version: string;
  transport: 'stdio' | 'http' | 'sse';

  // For HTTP transport
  port?: number; // Default: 3000
  host?: string; // Default: 'localhost'

  logging?: boolean; // Enable console logging
}
```

### Server Methods

```typescript
const server = new MCPServer(config);

// Tools
server.registerTool(tool);
server.registerTools([tool1, tool2]);
server.unregisterTool('tool_name');
server.getRegisteredTools();

// Resources
server.registerResource(resourceConfig);
server.registerResources([resource1, resource2]);
server.unregisterResource('memory://threads');
server.getRegisteredResources();

// Prompts
server.registerPrompt(promptConfig);
server.registerPrompts([prompt1, prompt2]);
server.unregisterPrompt('summarize');
server.getRegisteredPrompts();

// Lifecycle
await server.start();
server.isRunning();
await server.stop();
```

### Registering Resources

Expose data to MCP clients via resources. Supports both static URIs and dynamic URI templates.

```typescript
const server = new MCPServer({
  name: 'memory-server',
  version: '1.0.0',
  transport: 'stdio',
});

// Static resource with fixed URI
server.registerResource({
  uri: 'memory://threads',
  name: 'Conversation Threads',
  description: 'List of all conversation threads',
  mimeType: 'application/json',
  read: async () => ({
    text: JSON.stringify(await getAllThreads()),
  }),
});

// Dynamic resource with URI template
server.registerResource({
  uri: 'memory://thread/{id}',
  name: 'Thread Content',
  description: 'Content of a specific thread',
  mimeType: 'application/json',
  read: async ({ id }) => ({
    text: JSON.stringify(await getThread(id)),
  }),
});

// Resource returning binary data
server.registerResource({
  uri: 'files://avatar/{userId}',
  name: 'User Avatar',
  mimeType: 'image/png',
  read: async ({ userId }) => ({
    blob: await getAvatarBase64(userId),
  }),
});
```

### Registering Prompts

Expose reusable prompt templates to MCP clients.

```typescript
const server = new MCPServer({
  name: 'prompt-server',
  version: '1.0.0',
  transport: 'stdio',
});

// Simple prompt
server.registerPrompt({
  name: 'summarize',
  title: 'Summarize Content',
  description: 'Generate a summary of the provided content',
  arguments: [
    { name: 'content', description: 'Content to summarize', required: true },
    { name: 'style', description: 'Summary style (brief/detailed)', required: false },
  ],
  get: async ({ content, style = 'brief' }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Please provide a ${style} summary of:\n\n${content}`,
        },
      },
    ],
  }),
});

// Code review prompt
server.registerPrompt({
  name: 'review-code',
  title: 'Code Review',
  description: 'Review code for issues and improvements',
  arguments: [
    { name: 'code', description: 'Code to review', required: true },
    { name: 'language', description: 'Programming language', required: false },
  ],
  get: async ({ code, language }) => ({
    description: `Reviewing ${language || 'code'}`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Review this ${language || ''} code for best practices and issues:\n\n\`\`\`${language || ''}\n${code}\n\`\`\``,
        },
      },
    ],
  }),
});
```

### Resource Configuration

```typescript
interface MCPResourceConfig {
  uri: string; // Static URI or template like 'memory://thread/{id}'
  name: string;
  description?: string;
  mimeType?: string;
  read: (params: Record<string, string>) => Promise<MCPResourceContent | MCPResourceContent[]>;
}

interface MCPResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string; // Text content
  blob?: string; // Base64 encoded binary
}
```

### Prompt Configuration

```typescript
interface MCPPromptConfig {
  name: string;
  title?: string;
  description?: string;
  arguments?: MCPPromptArgumentConfig[];
  get: (args: Record<string, string>) => Promise<MCPPromptResult> | MCPPromptResult;
}

interface MCPPromptArgumentConfig {
  name: string;
  description?: string;
  required?: boolean;
}

interface MCPPromptResult {
  messages: MCPPromptMessage[];
  description?: string;
}
```

### HTTP Server

Run MCP over HTTP:

```typescript
const server = new MCPServer({
  name: 'http-tools',
  version: '1.0.0',
  transport: 'http',
  port: 3001,
  host: '0.0.0.0',
  logging: true,
});

server.registerTools(myTools);
await server.start();
// Server listening on http://0.0.0.0:3001/mcp
```

### Stdio Server (for Claude Desktop)

Create a script that Claude Desktop can execute:

```typescript
// serve-tools.ts
import { serveMCPTools } from '@cogitator-ai/mcp';
import { builtinTools } from '@cogitator-ai/core';

await serveMCPTools(builtinTools, {
  name: 'cogitator-tools',
  version: '1.0.0',
  transport: 'stdio',
});
```

Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "cogitator": {
      "command": "npx",
      "args": ["tsx", "/path/to/serve-tools.ts"]
    }
  }
}
```

---

## Tool Adapters

Convert between Cogitator and MCP tool formats.

### Cogitator → MCP

```typescript
import { cogitatorToMCP } from '@cogitator-ai/mcp';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const myTool = tool({
  name: 'greet',
  description: 'Greet someone',
  parameters: z.object({
    name: z.string(),
  }),
  execute: async ({ name }) => `Hello, ${name}!`,
});

const mcpDefinition = cogitatorToMCP(myTool);
// {
//   name: 'greet',
//   description: 'Greet someone',
//   inputSchema: {
//     type: 'object',
//     properties: { name: { type: 'string' } },
//     required: ['name']
//   }
// }
```

### MCP → Cogitator

```typescript
import { mcpToCogitator, wrapMCPTools } from '@cogitator-ai/mcp';

// Single tool
const cogitatorTool = mcpToCogitator(mcpToolDefinition, mcpClient, {
  namePrefix: 'mcp_',
  descriptionTransform: (desc) => `[MCP] ${desc}`,
});

// All tools from a client
const tools = await wrapMCPTools(client, {
  namePrefix: 'fs_',
});
```

### Adapter Options

```typescript
interface ToolAdapterOptions {
  namePrefix?: string;
  descriptionTransform?: (description: string) => string;
}
```

---

## Schema Converters

Convert between Zod schemas and JSON Schema.

### Zod → JSON Schema

```typescript
import { zodToJsonSchema } from '@cogitator-ai/mcp';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1).describe('User name'),
  age: z.number().int().min(0).optional(),
  email: z.string().email(),
  role: z.enum(['admin', 'user', 'guest']),
});

const jsonSchema = zodToJsonSchema(schema);
// {
//   type: 'object',
//   properties: {
//     name: { type: 'string', minLength: 1, description: 'User name' },
//     age: { type: 'integer', minimum: 0 },
//     email: { type: 'string', format: 'email' },
//     role: { type: 'string', enum: ['admin', 'user', 'guest'] }
//   },
//   required: ['name', 'email', 'role']
// }
```

### JSON Schema → Zod

```typescript
import { jsonSchemaToZod } from '@cogitator-ai/mcp';

const jsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['query'],
};

const zodSchema = jsonSchemaToZod(jsonSchema);

const result = zodSchema.parse({
  query: 'test',
  limit: 10,
  tags: ['a', 'b'],
});
```

### Supported Conversions

| JSON Schema                      | Zod                      |
| -------------------------------- | ------------------------ |
| `string`                         | `z.string()`             |
| `string` + `minLength/maxLength` | `z.string().min().max()` |
| `string` + `pattern`             | `z.string().regex()`     |
| `string` + `format: email`       | `z.string().email()`     |
| `string` + `format: uri`         | `z.string().url()`       |
| `number`                         | `z.number()`             |
| `integer`                        | `z.number().int()`       |
| `number` + `minimum/maximum`     | `z.number().min().max()` |
| `boolean`                        | `z.boolean()`            |
| `array`                          | `z.array()`              |
| `object`                         | `z.object()`             |
| `null`                           | `z.null()`               |
| `enum`                           | `z.enum()`               |

---

## Resources

Access data from MCP servers that expose resources.

```typescript
const client = await MCPClient.connect(config);

const resources = await client.listResources();
// [
//   { uri: 'file:///path/to/file.txt', name: 'file.txt', mimeType: 'text/plain' },
//   { uri: 'config://settings', name: 'Settings', description: 'App settings' },
// ]

const content = await client.readResource('file:///path/to/file.txt');
// {
//   uri: 'file:///path/to/file.txt',
//   mimeType: 'text/plain',
//   text: 'File contents here...',
// }

if (content.blob) {
  const data = Buffer.from(content.blob, 'base64');
}
```

### Resource Types

```typescript
interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string; // Base64 encoded
}
```

---

## Prompts

Access prompt templates from MCP servers.

```typescript
const client = await MCPClient.connect(config);

const prompts = await client.listPrompts();
// [
//   {
//     name: 'code_review',
//     description: 'Review code for issues',
//     arguments: [
//       { name: 'code', required: true },
//       { name: 'language', required: false }
//     ]
//   }
// ]

const messages = await client.getPrompt('code_review', {
  code: 'function add(a, b) { return a + b; }',
  language: 'javascript',
});
// [
//   {
//     role: 'user',
//     content: { type: 'text', text: 'Please review this JavaScript code...' }
//   }
// ]
```

### Prompt Types

```typescript
interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: MCPPromptArgument[];
}

interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

interface MCPPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri: string; text?: string; blob?: string };
  };
}
```

---

## Examples

### Multi-Server Integration

Use tools from multiple MCP servers:

```typescript
import { MCPClient, wrapMCPTools } from '@cogitator-ai/mcp';
import { Agent, Cogitator } from '@cogitator-ai/core';

const fsClient = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem', '/workspace'],
});

const gitClient = await MCPClient.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-git'],
});

const fsTools = await wrapMCPTools(fsClient, { namePrefix: 'fs_' });
const gitTools = await wrapMCPTools(gitClient, { namePrefix: 'git_' });

const agent = new Agent({
  name: 'Dev Assistant',
  model: 'ollama/llama3.1:8b',
  instructions: 'You can manage files and git repositories.',
  tools: [...fsTools, ...gitTools],
});

const cog = new Cogitator();
const result = await cog.run(agent, {
  input: 'Create a new file called hello.ts and commit it',
});

await fsClient.close();
await gitClient.close();
await cog.close();
```

### Capability-Based Tool Selection

Check server capabilities before using features:

```typescript
const client = await MCPClient.connect(config);
const capabilities = client.getCapabilities();

const tools: Tool[] = [];

if (capabilities.tools) {
  tools.push(...(await client.getTools()));
}

if (capabilities.resources) {
  const resources = await client.listResources();
  console.log(`Available resources: ${resources.length}`);
}

if (capabilities.prompts) {
  const prompts = await client.listPrompts();
  console.log(`Available prompts: ${prompts.length}`);
}
```

### Error Handling

```typescript
import { MCPClient } from '@cogitator-ai/mcp';

try {
  const client = await MCPClient.connect({
    transport: 'stdio',
    command: 'nonexistent-command',
    timeout: 5000,
  });
} catch (error) {
  if (error.message.includes('timeout')) {
    console.error('Connection timed out');
  } else if (error.message.includes('ENOENT')) {
    console.error('Command not found');
  } else {
    console.error('Connection failed:', error.message);
  }
}
```

### Content Conversion

Handle different content types from tool results:

```typescript
import { resultToMCPContent, mcpContentToResult } from '@cogitator-ai/mcp';

const result = { data: [1, 2, 3], status: 'ok' };
const mcpContent = resultToMCPContent(result);
// [{ type: 'text', text: '{"data":[1,2,3],"status":"ok"}' }]

const parsed = mcpContentToResult(mcpContent);
// { data: [1, 2, 3], status: 'ok' }

const textResult = resultToMCPContent('Hello world');
// [{ type: 'text', text: 'Hello world' }]
```

---

## Type Reference

```typescript
import type {
  // Transport
  MCPTransportType,

  // Client
  MCPClientConfig,
  MCPRetryConfig,

  // Server
  MCPServerConfig,
  MCPResourceConfig,
  MCPPromptConfig,
  MCPPromptArgumentConfig,
  MCPPromptResult,

  // Tools
  MCPToolDefinition,
  MCPToolCallResult,
  MCPToolContent,

  // Resources
  MCPResource,
  MCPResourceContent,

  // Prompts
  MCPPrompt,
  MCPPromptArgument,
  MCPPromptMessage,

  // Adapters
  ToolAdapterOptions,
  ConvertedTools,
} from '@cogitator-ai/mcp';
```

---

## License

MIT
