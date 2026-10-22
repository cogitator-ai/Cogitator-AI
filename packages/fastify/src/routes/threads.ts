import type { FastifyPluginAsync } from 'fastify';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import type { ThreadResponse, AddMessageRequest, ThreadPageQuery } from '../types.js';
import { AddMessageRequestSchema, ThreadPageQuerySchema, ThreadResponseSchema } from '../types.js';
import {
  parseAddMessageRequest,
  parseThreadPageQuery,
  readThreadPage,
} from '@cogitator-ai/server-shared';
import { refuseThread, sendError, sendRouteError, validateBody, validateQuery } from './utils.js';

interface ThreadParams {
  id: string;
}

export const threadRoutes: FastifyPluginAsync = async (fastify) => {
  const getMemory = () => fastify.cogitator.runtime.getMemory();
  const messageBody = validateBody((body) =>
    parseAddMessageRequest(body, { roles: fastify.cogitator.threadMessageRoles })
  );
  const pageQuery = validateQuery(parseThreadPageQuery);

  fastify.get<{ Params: ThreadParams; Querystring: ThreadPageQuery }>(
    '/threads/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        querystring: ThreadPageQuerySchema,
        response: { 200: ThreadResponseSchema },
      },
      preValidation: pageQuery,
    },
    async (request, reply) => {
      const memory = await getMemory();
      if (!memory) {
        return sendError(reply, 503, 'Memory not configured', 'UNAVAILABLE');
      }

      const { id } = request.params;
      const userId = request.cogitatorAuth?.userId;

      if (await refuseThread(request, reply, id)) return reply;

      try {
        const thread = await assertThreadAccess(memory, id, userId);
        const response: ThreadResponse = await readThreadPage(memory, id, request.query, thread);
        return response;
      } catch (error) {
        return sendRouteError(request, reply, error, 'thread get error');
      }
    }
  );

  fastify.post<{ Params: ThreadParams; Body: AddMessageRequest }>(
    '/threads/:id/messages',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        body: AddMessageRequestSchema,
      },
      preValidation: messageBody,
    },
    async (request, reply) => {
      const memory = await getMemory();
      if (!memory) {
        return sendError(reply, 503, 'Memory not configured', 'UNAVAILABLE');
      }

      const { id } = request.params;
      const body = request.body;
      const userId = request.cogitatorAuth?.userId;

      if (await refuseThread(request, reply, id)) return reply;

      try {
        await ensureThreadAccess(memory, id, { agentId: '', userId });
        const result = await memory.addEntry({
          threadId: id,
          message: {
            role: body.role,
            content: body.content,
          },
          tokenCount: 0,
          metadata: body.metadata,
        });

        if (!result.success) {
          return sendRouteError(
            request,
            reply,
            new Error(result.error),
            'thread add message error'
          );
        }

        return reply.status(201).send({ success: true });
      } catch (error) {
        return sendRouteError(request, reply, error, 'thread add message error');
      }
    }
  );

  fastify.delete<{ Params: ThreadParams }>(
    '/threads/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const memory = await getMemory();
      if (!memory) {
        return sendError(reply, 503, 'Memory not configured', 'UNAVAILABLE');
      }

      const { id } = request.params;
      const userId = request.cogitatorAuth?.userId;

      if (await refuseThread(request, reply, id)) return reply;

      try {
        await assertThreadAccess(memory, id, userId);
        const result = await memory.clearThread(id);
        if (!result.success) {
          return sendRouteError(request, reply, new Error(result.error), 'thread delete error');
        }
        return reply.status(204).send();
      } catch (error) {
        return sendRouteError(request, reply, error, 'thread delete error');
      }
    }
  );
};
