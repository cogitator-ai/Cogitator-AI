/**
 * Threads API Routes
 *
 * Implements OpenAI Threads API endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter.js';
import type {
  CreateThreadRequest,
  CreateMessageRequest,
  ListResponse,
  Message,
} from '../../types/openai-types.js';

export function registerThreadRoutes(
  fastify: FastifyInstance,
  adapter: OpenAIAdapter
) {
  fastify.post<{ Body: CreateThreadRequest }>(
    '/v1/threads',
    async (request, reply) => {
      const thread = adapter.createThread(request.body?.metadata);

      if (request.body?.messages) {
        for (const msg of request.body.messages) {
          const content = typeof msg.content === 'string'
            ? msg.content
            : msg.content.map((c) => c.type === 'text' ? c.text : '').join('');
          adapter.addMessage(thread.id, { role: msg.role, content, metadata: msg.metadata });
        }
      }

      return reply.status(201).send(thread);
    }
  );

  fastify.get<{ Params: { thread_id: string } }>(
    '/v1/threads/:thread_id',
    async (request, reply) => {
      const thread = adapter.getThread(request.params.thread_id);

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
      const thread = adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      if (request.body?.metadata) {
        Object.assign(thread.metadata, request.body.metadata);
      }

      return reply.send(thread);
    }
  );

  fastify.delete<{ Params: { thread_id: string } }>(
    '/v1/threads/:thread_id',
    async (request, reply) => {
      const deleted = adapter.deleteThread(request.params.thread_id);

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
      const thread = adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      const content = typeof request.body.content === 'string'
        ? request.body.content
        : request.body.content.map((c) => c.type === 'text' ? c.text : '').join('');
      const message = adapter.addMessage(request.params.thread_id, {
        role: request.body.role,
        content,
        metadata: request.body.metadata,
      });

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
    Querystring: { limit?: number; order?: 'asc' | 'desc'; after?: string; before?: string; run_id?: string };
  }>(
    '/v1/threads/:thread_id/messages',
    async (request, reply) => {
      const thread = adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      const { limit = 20, order = 'desc', after, before, run_id } = request.query;
      const messages = adapter.listMessages(request.params.thread_id, {
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
    }
  );

  fastify.get<{ Params: { thread_id: string; message_id: string } }>(
    '/v1/threads/:thread_id/messages/:message_id',
    async (request, reply) => {
      const thread = adapter.getThread(request.params.thread_id);

      if (!thread) {
        return reply.status(404).send({
          error: {
            message: `No thread found with id '${request.params.thread_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      const message = adapter.getMessage(
        request.params.thread_id,
        request.params.message_id
      );

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

