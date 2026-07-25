import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { buildSseErrorEvent } from './sse-error-event.js';

export function a2aFastify(server: A2AServer): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof SyntaxError || error.statusCode === 400) {
        return reply.send(createErrorResponse(null, errors.parseError('Invalid JSON body')));
      }
      return reply.send(createErrorResponse(null, errors.internalError(error.message)));
    });

    fastify.get('/.well-known/agent.json', async (_request, reply) => {
      const cards = server.getAgentCards();
      return reply.send(cards.length === 1 ? cards[0] : cards);
    });

    fastify.post('/a2a', async (request, reply) => {
      const contentType = request.headers['content-type'];
      if (contentType && !contentType.startsWith('application/json')) {
        return reply.send(createErrorResponse(null, errors.contentTypeNotSupported(contentType)));
      }

      const body = request.body as Record<string, unknown> | undefined;
      const isStreaming =
        request.headers.accept?.includes('text/event-stream') || body?.method === 'message/stream';

      if (isStreaming) {
        void reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        try {
          for await (const event of server.handleJsonRpcStream(body)) {
            if (reply.raw.writableEnded) break;
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (!reply.raw.writableEnded) reply.raw.write('data: [DONE]\n\n');
        } catch (error) {
          if (!reply.raw.writableEnded) {
            reply.raw.write(`data: ${JSON.stringify(buildSseErrorEvent(error))}\n\n`);
          }
        }
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }

      try {
        const response = await server.handleJsonRpc(body);
        return reply.send(response);
      } catch (error) {
        return reply.send(createErrorResponse(null, errors.internalError(String(error))));
      }
    });
  };
}
