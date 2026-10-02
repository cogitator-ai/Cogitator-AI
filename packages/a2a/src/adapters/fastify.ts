import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { firstHeader, isStreamRequest, pipeJsonRpcStream, SSE_HEADERS } from './shared.js';

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

      const body: unknown = request.body;
      const authToken = server.getAuthToken((name) =>
        firstHeader(request.headers[name.toLowerCase()])
      );

      if (isStreamRequest(body)) {
        void reply.hijack();
        const raw = reply.raw;
        const controller = new AbortController();
        raw.on('close', () => controller.abort());
        raw.writeHead(200, SSE_HEADERS);

        await pipeJsonRpcStream(server, body, authToken, controller.signal, (frame) => {
          if (!raw.writableEnded && !raw.destroyed) raw.write(frame);
        });
        if (!raw.writableEnded) raw.end();
        return;
      }

      try {
        const response = await server.handleJsonRpc(body, authToken);
        if (response === null) {
          return reply.code(204).send();
        }
        return reply.send(response);
      } catch (error) {
        return reply.send(createErrorResponse(null, errors.internalError(String(error))));
      }
    });
  };
}
