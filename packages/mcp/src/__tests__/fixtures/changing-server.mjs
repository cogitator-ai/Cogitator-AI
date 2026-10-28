import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'changing', version: '1.0.0' });
server.registerTool(
  'first',
  { description: 'First', inputSchema: { x: z.string().optional() } },
  async () => ({
    content: [{ type: 'text', text: 'first' }],
  })
);
await server.connect(new StdioServerTransport());
setTimeout(() => {
  server.registerTool('second', { description: 'Second', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'second' }],
  }));
}, 500);
