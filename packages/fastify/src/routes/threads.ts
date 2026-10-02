import type { FastifyPluginAsync } from 'fastify';
import type { ThreadResponse, AddMessageRequest } from '../types.js';
import { AddMessageRequestSchema } from '../types.js';
import { sendError, sendRouteError } from './utils.js';

interface ThreadParams {
  id: string;
}

export const threadRoutes: FastifyPluginAsync = async (fastify) => {
  const getMemory = () => fastify.cogitator.runtime.memory;

  fastify.get<{ Params: ThreadParams }>(
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
      const memory = getMemory();
      if (!memory) {
        return sendError(reply, 503, 'Memory not configured', 'UNAVAILABLE');
      }

      const { id } = request.params;

      try {
        const result = await memory.getEntries({ threadId: id });
        if (!result.success) {
          return sendError(reply, 500, result.error ?? 'Unknown error', 'INTERNAL');
        }

        const entries = result.data;
        const messages = entries.map((entry) => entry.message);
        const now = Date.now();
        const response: ThreadResponse = {
          id,
          messages,
          createdAt: entries.length > 0 ? entries[0].createdAt.getTime() : now,
          updatedAt: entries.length > 0 ? entries[entries.length - 1].createdAt.getTime() : now,
        };
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
    },
    async (request, reply) => {
      const memory = getMemory();
      if (!memory) {
        return sendError(reply, 503, 'Memory not configured', 'UNAVAILABLE');
      }

      const { id } = request.params;
      const body = request.body;

      try {
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
          return sendError(reply, 500, result.error ?? 'Unknown error', 'INTERNAL');
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
      const memory = getMemory();
      if (!memory) {
        return sendError(reply, 503, 'Memory not configured', 'UNAVAILABLE');
      }

      const { id } = request.params;

      try {
        const result = await memory.clearThread(id);
        if (!result.success) {
          return sendError(reply, 500, result.error ?? 'Unknown error', 'INTERNAL');
        }
        return reply.status(204).send();
      } catch (error) {
        return sendRouteError(request, reply, error, 'thread delete error');
      }
    }
  );
};
