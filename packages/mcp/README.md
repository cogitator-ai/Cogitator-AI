# @cogitator/mcp

MCP (Model Context Protocol) integration for Cogitator. Connect to external MCP servers or expose Cogitator tools as an MCP server.

## Installation

```bash
pnpm add @cogitator/mcp
```

## Usage

### MCP Client

Connect to external MCP servers:

```typescript
import { MCPClient } from '@cogitator/mcp';

const client = new MCPClient({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@anthropic/mcp-server-filesystem'],
});

await client.connect();

// List available tools
const tools = await client.listTools();

// Execute a tool
const result = await client.executeTool('read_file', {
  path: '/path/to/file.txt',
});

// Get tools as Cogitator tools
const cogitatorTools = client.asCogitatorTools();
```

### MCP Server

Expose Cogitator tools as an MCP server:

```typescript
import { MCPServer } from '@cogitator/mcp';
import { builtinTools } from '@cogitator/core';

const server = new MCPServer({
  name: 'cogitator-tools',
  version: '1.0.0',
  tools: builtinTools,
});

// Start stdio server
await server.start('stdio');

// Or HTTP server
await server.start('http', { port: 3001 });
```

### Tool Adapter

Convert between Cogitator and MCP tool formats:

```typescript
import { toMCPTool, toCogitatorTool } from '@cogitator/mcp';

// Cogitator → MCP
const mcpTool = toMCPTool(cogitatorTool);

// MCP → Cogitator
const cogitatorTool = toCogitatorTool(mcpTool);
```

## Documentation

See the [Cogitator documentation](https://github.com/eL1fe/cogitator) for full API reference.

## License

MIT
