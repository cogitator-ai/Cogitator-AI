/**
 * Threads API Routes
 *
 * Implements OpenAI Threads API endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter';
import type {
  CreateThreadRequest,
  CreateMessageRequest,
  ListResponse,
  Message,
} from '../../types/openai-types';
import { parseLimit, parseOrder, sendInvalidRequest } from './shared';

function validateMessage(message: Partial<CreateMessageRequest> | undefined): string | null {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
    return "role must be 'user' or 'assistant'";
  }
  if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
    return 'content must be a string or an array of content parts';
  }
  return null;
}

export function registerThreadRoutes(fastify: FastifyInstance, adapter: OpenAIAdapter) {
  fastify.post<{ Body: CreateThreadRequest }>('/v1/threads', async (request, reply) => {
    const messages = request.body?.messages ?? [];
    for (const msg of messages) {
      const problem = validateMessage(msg);
      if (problem) return sendInvalidRequest(reply, problem, 'messages');
    }

    const thread = await adapter.createThread(request.body?.metadata);
    for (const msg of messages) {
      await adapter.addMessage(thread.id, msg);
    }

    return reply.status(201).send(thread);
  });

  fastify.get<{ Params: { thread_id: string } }>(
    '/v1/threads/:thread_id',
    async (request, reply) => {
      const thread = await adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(thread);
    }
  );

  fastify.post<{ Params: { thread_id: string }; Body: { metadata?: Record<string, string> } }>(
    '/v1/threads/:thread_id',
    async (request, reply) => {
      const updated = await adapter.updateThread(request.params.thread_id, {
        metadata: request.body?.metadata,
      });

      if (!updated) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(updated);
    }
  );

  fastify.delete<{ Params: { thread_id: string } }>(
    '/v1/threads/:thread_id',
    async (request, reply) => {
      const deleted = await adapter.deleteThread(request.params.thread_id);

      if (!deleted) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send({
        id: request.params.thread_id,
        object: 'thread.deleted',
        deleted: true,
      });
    }
  );

  fastify.post<{ Params: { thread_id: string }; Body: CreateMessageRequest }>(
    '/v1/threads/:thread_id/messages',
    async (request, reply) => {
      const thread = await adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      const problem = validateMessage(request.body);
      if (problem) return sendInvalidRequest(reply, problem);

      const message = await adapter.addMessage(request.params.thread_id, request.body);

      if (!message) {
        return reply.status(500).send({
          error: {
            message: 'Failed to create message',
            type: 'server_error',
            code: 'internal_error',
          },
        });
      }

      return reply.status(201).send(message);
    }
  );

  fastify.get<{
    Params: { thread_id: string };
    Querystring: {
      limit?: string;
      order?: string;
      after?: string;
      before?: string;
      run_id?: string;
    };
  }>('/v1/threads/:thread_id/messages', async (request, reply) => {
    const thread = await adapter.getThread(request.params.thread_id);

    if (!thread) {
      return reply.status(404).send({
        error: {
          message: `No thread found with id '${request.params.thread_id}'`,
          type: 'invalid_request_error',
          code: 'not_found',
        },
      });
    }

    const limit = parseLimit(request.query.limit);
    if (limit === null)
      return sendInvalidRequest(reply, 'limit must be between 1 and 100', 'limit');
    const order = parseOrder(request.query.order);
    if (order === null) return sendInvalidRequest(reply, "order must be 'asc' or 'desc'", 'order');
    const { after, before, run_id } = request.query;
    const messages = await adapter.listMessages(request.params.thread_id, {
      limit: limit + 1,
      order,
      after,
      before,
      run_id,
    });

    const hasMore = messages.length > limit;
    const data = messages.slice(0, limit);

    const response: ListResponse<Message> = {
      object: 'list',
      data,
      first_id: data[0]?.id,
      last_id: data[data.length - 1]?.id,
      has_more: hasMore,
    };

    return reply.send(response);
  });

  fastify.get<{ Params: { thread_id: string; message_id: string } }>(
    '/v1/threads/:thread_id/messages/:message_id',
    async (request, reply) => {
      const thread = await adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      const message = await adapter.getMessage(request.params.thread_id, request.params.message_id);

      if (!message) {
        return reply.status(404).send({
          error: {
            message: `No message found with id '${request.params.message_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(message);
    }
  );
}
