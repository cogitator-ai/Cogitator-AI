import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ping', version: '1.0.0' });
server.registerTool(
  'ping',
  {
    description: 'Answers pong',
    inputSchema: { word: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ word }) => ({ content: [{ type: 'text', text: `pong ${word ?? ''}`.trim() }] })
);
server.registerTool(
  'env',
  { description: 'Reads an environment variable', inputSchema: { name: z.string() } },
  async ({ name }) => ({
    content: [{ type: 'text', text: process.env[name] ?? '' }],
  })
);
await server.connect(new StdioServerTransport());
