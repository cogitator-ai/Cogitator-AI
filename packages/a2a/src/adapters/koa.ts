import type { Middleware, Context } from 'koa';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';

export function a2aKoa(server: A2AServer): Middleware {
  return async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.path === '/.well-known/agent.json' && ctx.method === 'GET') {
      const cards = server.getAgentCards();
      ctx.body = cards.length === 1 ? cards[0] : cards;
      return;
    }

    if (ctx.path === '/a2a' && ctx.method === 'POST') {
      const contentType = ctx.headers['content-type'];
      if (contentType && !contentType.includes('application/json')) {
        ctx.body = createErrorResponse(null, errors.contentTypeNotSupported(contentType));
        return;
      }

      const body = (ctx.request as unknown as { body?: Record<string, unknown> }).body;
      if (!body) {
        ctx.body = createErrorResponse(
          null,
          errors.parseError('Request body not parsed. Ensure body-parsing middleware is applied.')
        );
        return;
      }
      const isStreaming =
        ctx.headers.accept?.includes('text/event-stream') || body.method === 'message/stream';

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
            if (res.writableEnded) break;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (!res.writableEnded) res.write('data: [DONE]\n\n');
        } catch (error) {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
          }
        }
        if (!res.writableEnded) res.end();
        return;
      }

      try {
        const response = await server.handleJsonRpc(body);
        ctx.body = response;
      } catch (error) {
        ctx.body = createErrorResponse(null, errors.internalError(String(error)));
      }
      return;
    }

    await next();
  };
}
