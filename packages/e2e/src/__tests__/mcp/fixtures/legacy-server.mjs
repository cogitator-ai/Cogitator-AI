import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'e2e-legacy', version: '1.0.0' });
server.registerTool(
  'shout',
  { description: 'Upper-cases the text', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] })
);
server.registerTool(
  'confirm_delete',
  { description: 'Asks before deleting', inputSchema: { path: z.string() } },
  async ({ path }) => {
    const reply = await server.server.elicitInput({
      message: `Delete ${path}?`,
      requestedSchema: {
        type: 'object',
        properties: { yes: { type: 'boolean' } },
        required: ['yes'],
      },
    });
    const yes = reply.action === 'accept' && reply.content?.yes === true;
    return { content: [{ type: 'text', text: yes ? `deleted ${path}` : 'kept' }] };
  }
);
await server.connect(new StdioServerTransport());
