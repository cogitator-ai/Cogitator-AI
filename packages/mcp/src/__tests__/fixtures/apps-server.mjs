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
    'move_card',
    {
      description: 'Moves a card, for the board page only',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({ content: [{ type: 'text', text: 'moved' }] })
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
