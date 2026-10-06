import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH } from '../types.js';
import { firstHeader, handleA2AHttp, mountUrlOf } from './shared.js';

/**
 * Fastify plugin serving an A2A server: the Agent Card at `/.well-known/agent-card.json` (and the
 * pre-v0.3 `/.well-known/agent.json`), JSON-RPC at `basePath`, and every agent's own card and
 * endpoint under `<basePath>/<agent name>`.
 */
export function a2aFastify(server: A2AServer): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof SyntaxError || error.statusCode === 400) {
        return reply.send(createErrorResponse(null, errors.parseError('Invalid JSON body')));
      }
      if (error.statusCode === 415) {
        return reply
          .code(415)
          .send(
            createErrorResponse(
              null,
              errors.invalidRequest('Content-Type must be application/json')
            )
          );
      }
      if (
        typeof error.statusCode === 'number' &&
        error.statusCode > 400 &&
        error.statusCode < 500
      ) {
        return reply.send(createErrorResponse(null, errors.invalidRequest(error.message)));
      }
      return reply.send(
        createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'))
      );
    });

    const serve = async (
      request: FastifyRequest,
      reply: FastifyReply,
      relativePath: string
    ): Promise<unknown> => {
      const controller = new AbortController();
      reply.raw.on('close', () => controller.abort());
      const requestUrl = new URL(request.url, `${request.protocol}://${request.host}`);
      const response = await handleA2AHttp(server, {
        method: request.method,
        path: relativePath,
        mountUrl: mountUrlOf(requestUrl, relativePath),
        header: (name) => firstHeader(request.headers[name.toLowerCase()]),
        readBody: async () => request.body,
        signal: controller.signal,
      });
      switch (response.kind) {
        case 'json':
          return reply.code(response.status).headers(response.headers).send(response.body);
        case 'empty':
          return reply.code(response.status).send();
        case 'pass':
          return reply.callNotFound();
        case 'sse': {
          void reply.hijack();
          const raw = reply.raw;
          raw.writeHead(200, response.headers);
          await response.pipe((frame) => {
            if (!raw.writableEnded && !raw.destroyed) raw.write(frame);
          });
          if (!raw.writableEnded) raw.end();
          return reply;
        }
      }
    };

    const base = server.basePath.replace(/\/+$/, '');
    const agentPath = (request: FastifyRequest) =>
      `${base}/${encodeURIComponent((request.params as { agent?: string }).agent ?? '')}`;

    fastify.get(AGENT_CARD_PATH, (request, reply) => serve(request, reply, AGENT_CARD_PATH));
    fastify.get(LEGACY_AGENT_CARD_PATH, (request, reply) =>
      serve(request, reply, LEGACY_AGENT_CARD_PATH)
    );
    fastify.get(`${base}/:agent${AGENT_CARD_PATH}`, (request, reply) =>
      serve(request, reply, `${agentPath(request)}${AGENT_CARD_PATH}`)
    );
    fastify.post(server.basePath, (request, reply) => serve(request, reply, server.basePath));
    fastify.post(`${base}/:agent`, (request, reply) => serve(request, reply, agentPath(request)));
  };
}
