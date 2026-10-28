import { McpServer, acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const legacy = process.argv.includes('--modern-only') ? 'reject' : 'serve';

serveStdio(
  () => {
    const server = new McpServer({ name: 'modern', version: '2.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echoes', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text }] })
    );
    server.registerTool(
      'greet',
      { description: 'Asks a name, then greets', inputSchema: z.object({}) },
      async (_args, ctx) => {
        const answer = acceptedContent(ctx.mcpReq.inputResponses, 'name');
        const state = ctx.mcpReq.requestState();
        if (!answer) {
          return inputRequired({
            inputRequests: {
              name: inputRequired.elicit({
                message: 'Your name?',
                requestedSchema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              }),
            },
            requestState: 'opaque-state-1',
          });
        }
        return { content: [{ type: 'text', text: `hello ${answer.name} (state ${state})` }] };
      }
    );
    server.registerTool(
      'nag',
      { description: 'Never satisfied', inputSchema: z.object({}) },
      async () =>
        inputRequired({
          inputRequests: {
            again: inputRequired.elicit({
              message: 'Again?',
              requestedSchema: { type: 'object', properties: {} },
            }),
          },
        })
    );
    server.registerTool(
      'sign_in',
      { description: 'Asks to open a page', inputSchema: z.object({}) },
      async (_args, ctx) => {
        const reply = ctx.mcpReq.inputResponses?.page;
        if (!reply) {
          return inputRequired({
            inputRequests: {
              page: inputRequired.elicitUrl({
                message: 'Sign in to the service',
                url: 'https://example.com/sign-in',
              }),
            },
          });
        }
        return { content: [{ type: 'text', text: `signed in: ${reply.action}` }] };
      }
    );
    return server;
  },
  { legacy }
);
