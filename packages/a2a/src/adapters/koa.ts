import type { Middleware, Context } from 'koa';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { isStreamRequest, pipeJsonRpcStream, SSE_HEADERS } from './shared.js';

export function a2aKoa(server: A2AServer): Middleware {
  return async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.path === '/.well-known/agent.json' && ctx.method === 'GET') {
      const cards = server.getAgentCards();
      ctx.body = cards.length === 1 ? cards[0] : cards;
      return;
    }

    if (ctx.path === server.basePath && ctx.method === 'POST') {
      const contentType = ctx.headers['content-type'];
      if (contentType && !contentType.startsWith('application/json')) {
        ctx.body = createErrorResponse(null, errors.contentTypeNotSupported(contentType));
        return;
      }

      const body = (ctx.request as unknown as { body?: unknown }).body;
      if (body === undefined) {
        ctx.body = createErrorResponse(
          null,
          errors.parseError('Request body not parsed. Ensure body-parsing middleware is applied.')
        );
        return;
      }
      const authToken = server.getAuthToken((name) => ctx.get(name) || undefined);

      if (isStreamRequest(body)) {
        ctx.respond = false;
        const res = ctx.res;
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        res.writeHead(200, SSE_HEADERS);

        await pipeJsonRpcStream(server, body, authToken, controller.signal, (frame) => {
          if (!res.writableEnded && !res.destroyed) res.write(frame);
        });
        if (!res.writableEnded) res.end();
        return;
      }

      try {
        const response = await server.handleJsonRpc(body, authToken);
        if (response === null) {
          ctx.status = 204;
          return;
        }
        ctx.body = response;
      } catch (error) {
        ctx.body = createErrorResponse(
          null,
          errors.clientJsonRpcError(error, 'A2A request failed')
        );
      }
      return;
    }

    await next();
  };
}
