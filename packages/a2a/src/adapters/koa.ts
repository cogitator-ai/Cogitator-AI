import type { Middleware, Context } from 'koa';
import type { A2AServer } from '../server.js';

export function a2aKoa(server: A2AServer): Middleware {
  return async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.path === '/.well-known/agent.json' && ctx.method === 'GET') {
      const cards = server.getAgentCards();
      ctx.body = cards.length === 1 ? cards[0] : cards;
      return;
    }

    if (ctx.path === '/a2a' && ctx.method === 'POST') {
      const body = (ctx.request as unknown as { body: Record<string, unknown> }).body;
      const isStreaming =
        ctx.headers.accept === 'text/event-stream' || body?.method === 'message/stream';

      if (isStreaming) {
        ctx.respond = false;
        const res = ctx.res;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          for await (const event of server.handleJsonRpcStream(body)) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
        } catch (error) {
          res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
        }
        res.end();
        return;
      }

      const response = await server.handleJsonRpc(body);
      ctx.body = response;
      return;
    }

    await next();
  };
}
