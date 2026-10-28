import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const MIME = 'text/html;profile=mcp-app';

serveStdio(() => {
  const server = new McpServer({ name: 'apps', version: '1.0.0' });
  server.registerTool(
    'show_board',
    {
      description: 'Shows the board',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: 'ui://board/view' } },
    },
    async () => ({ content: [{ type: 'text', text: 'board' }] })
  );
  server.registerTool(
    'chart_board',
    {
      description: 'Charts the board',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: 'ui://board/view' } },
    },
    async () => ({
      content: [
        { type: 'text', text: 'The chart' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
      structuredContent: { cards: 2 },
    })
  );
  server.registerTool(
    'move_card',
    {
      description: 'Moves a card, for the board page only',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({ content: [{ type: 'text', text: 'moved' }] })
  );
  server.registerTool(
    'link_card',
    {
      description: 'Links the card file, for the board page only',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({
      content: [
        {
          type: 'resource_link',
          uri: 'file:///cards/todo.md',
          name: 'todo.md',
          mimeType: 'text/markdown',
          description: 'The card',
          _meta: { board: 'main' },
        },
      ],
    })
  );
  server.registerTool(
    'list_cards',
    {
      description: 'Lists the cards, for the board page only',
      inputSchema: z.object({}),
      outputSchema: z.array(z.string()),
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({
      content: [{ type: 'text', text: '["todo","done"]' }],
      structuredContent: ['todo', 'done'],
    })
  );
  server.registerTool(
    'count_cards',
    {
      description: 'Counts the cards, for the board page only',
      inputSchema: z.object({}),
      outputSchema: z.number(),
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({ content: [{ type: 'text', text: '2' }], structuredContent: 2 })
  );
  server.registerTool(
    'archive_board',
    {
      description: 'Archives the board, for the agent only',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['model'] } },
    },
    async () => ({ content: [{ type: 'text', text: 'archived' }] })
  );
  server.registerResource(
    'Board',
    'ui://board/view',
    {
      mimeType: MIME,
      _meta: {
        ui: {
          csp: { connectDomains: ['https://board.example.com'] },
          permissions: { clipboardWrite: {} },
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: 'ui://board/view',
          mimeType: MIME,
          text: '<p>board</p>',
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    })
  );
  return server;
});
