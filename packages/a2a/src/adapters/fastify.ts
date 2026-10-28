import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH, JWKS_PATH, LEGACY_AGENT_CARD_PATH } from '../types.js';
import { A2A_CONTENT_TYPE } from '../version.js';
import { restErrorBody, toRestError } from '../v1/errors.js';
import { firstHeader, handleA2AHttp, mountUrlOf } from './shared.js';
import { trimTrailingSlashes } from '../url.js';

/**
 * Fastify plugin serving an A2A server: the Agent Card at `/.well-known/agent-card.json` (and the
 * pre-v0.3 `/.well-known/agent.json`), JSON-RPC at `basePath`, every agent's own card and
 * endpoint under `<basePath>/<agent name>`, the A2A 1.0 HTTP+JSON binding under `restPath`
 * (bodies as `application/a2a+json` too), and the JWKS at `/.well-known/jwks.json`.
 */
export function a2aFastify(server: A2AServer): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    const restPattern = server.restPath ? `${server.restPath}/*` : null;
    const isRest = (request: FastifyRequest): boolean =>
      restPattern !== null && (request.routeOptions.url ?? '').endsWith(restPattern);

    fastify.removeContentTypeParser('application/json');
    fastify.addContentTypeParser(
      ['application/json', A2A_CONTENT_TYPE],
      { parseAs: 'string' },
      (request: FastifyRequest, body: string | Buffer, done) => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        if (text.trim() === '' && isRest(request)) {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(text) as unknown);
        } catch (error) {
          const failure = error instanceof Error ? error : new SyntaxError(String(error));
          Object.assign(failure, { statusCode: 400 });
          done(failure, undefined);
        }
      }
    );

    fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
      if (isRest(request)) {
        if (error.statusCode === 415) {
          return reply
            .code(415)
            .header('Content-Type', A2A_CONTENT_TYPE)
            .send(
              restErrorBody(
                415,
                'INVALID_ARGUMENT',
                `Content-Type must be ${A2A_CONTENT_TYPE} or application/json`
              )
            );
        }
        const failure =
          error instanceof SyntaxError || error.statusCode === 400
            ? new errors.A2AError(errors.parseError('Invalid JSON body'))
            : error;
        const { status, body } = toRestError(failure, 'A2A request failed');
        return reply.code(status).header('Content-Type', A2A_CONTENT_TYPE).send(body);
      }
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
        query: requestUrl.searchParams,
        header: (name) => firstHeader(request.headers[name.toLowerCase()]),
        readBody: async () => request.body,
        signal: controller.signal,
      });
      switch (response.kind) {
        case 'json':
          return reply.code(response.status).headers(response.headers).send(response.body);
        case 'empty':
          return reply
            .code(response.status)
            .headers(response.headers ?? {})
            .send();
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

    const base = trimTrailingSlashes(server.basePath);
    const agentPath = (request: FastifyRequest) =>
      `${base}/${encodeURIComponent((request.params as { agent?: string }).agent ?? '')}`;

    /** The path under `restPath` as it came, still percent-encoded, without the plugin prefix. */
    const restRelativePath = (request: FastifyRequest): string => {
      const pattern = request.routeOptions.url ?? '';
      const prefix = restPattern ? pattern.slice(0, pattern.length - restPattern.length) : '';
      const pathname = new URL(request.url, 'http://localhost').pathname;
      return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
    };

    fastify.get(AGENT_CARD_PATH, (request, reply) => serve(request, reply, AGENT_CARD_PATH));
    fastify.get(LEGACY_AGENT_CARD_PATH, (request, reply) =>
      serve(request, reply, LEGACY_AGENT_CARD_PATH)
    );
    fastify.get(JWKS_PATH, (request, reply) => serve(request, reply, JWKS_PATH));
    fastify.get(`${base}/:agent${AGENT_CARD_PATH}`, (request, reply) =>
      serve(request, reply, `${agentPath(request)}${AGENT_CARD_PATH}`)
    );
    fastify.post(server.basePath, (request, reply) => serve(request, reply, server.basePath));
    fastify.post(`${base}/:agent`, (request, reply) => serve(request, reply, agentPath(request)));
    if (restPattern) {
      fastify.route({
        method: ['GET', 'POST', 'DELETE'],
        url: restPattern,
        handler: (request, reply) => serve(request, reply, restRelativePath(request)),
      });
    }
  };
}
