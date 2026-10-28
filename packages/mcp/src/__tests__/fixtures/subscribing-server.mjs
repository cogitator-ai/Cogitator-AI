import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const calls = { subscribe: [], unsubscribe: [] };
const server = new McpServer(
  { name: 'subscribing', version: '1.0.0' },
  { capabilities: { resources: { subscribe: true } } }
);
server.registerResource('notes', 'notes://today', {}, async (uri) => ({
  contents: [{ uri: uri.href, text: 'notes' }],
}));
server.registerTool('calls', { description: 'Subscription calls so far' }, async () => ({
  content: [{ type: 'text', text: JSON.stringify(calls) }],
}));
server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  calls.subscribe.push(request.params.uri);
  return {};
});
server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  calls.unsubscribe.push(request.params.uri);
  return {};
});
await server.connect(new StdioServerTransport());
