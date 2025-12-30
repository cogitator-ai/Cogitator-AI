/**
 * Assistants API Routes
 *
 * Implements OpenAI Assistants API endpoints.
 */

import type { FastifyInstance } from 'fastify';
import type { OpenAIAdapter } from '../../client/openai-adapter';
import type {
  CreateAssistantRequest,
  UpdateAssistantRequest,
  ListResponse,
  Assistant,
} from '../../types/openai-types';

export function registerAssistantRoutes(
  fastify: FastifyInstance,
  adapter: OpenAIAdapter
) {
  fastify.post<{ Body: CreateAssistantRequest }>(
    '/v1/assistants',
    async (request, reply) => {
      const assistant = adapter.createAssistant(request.body);
      return reply.status(201).send(assistant);
    }
  );

  fastify.get<{ Querystring: { limit?: number; order?: 'asc' | 'desc'; after?: string; before?: string } }>(
    '/v1/assistants',
    async (request, reply) => {
      const assistants = adapter.listAssistants();

      let data = assistants;
      const { limit = 20, order = 'desc', after, before } = request.query;

      if (order === 'asc') {
        data.sort((a, b) => a.created_at - b.created_at);
      } else {
        data.sort((a, b) => b.created_at - a.created_at);
      }

      if (after) {
        const idx = data.findIndex((a) => a.id === after);
        if (idx !== -1) {
          data = data.slice(idx + 1);
        }
      }

      if (before) {
        const idx = data.findIndex((a) => a.id === before);
        if (idx !== -1) {
          data = data.slice(0, idx);
        }
      }

      const hasMore = data.length > limit;
      data = data.slice(0, limit);

      const response: ListResponse<Assistant> = {
        object: 'list',
        data,
        first_id: data[0]?.id,
        last_id: data[data.length - 1]?.id,
        has_more: hasMore,
      };

      return reply.send(response);
    }
  );

  fastify.get<{ Params: { assistant_id: string } }>(
    '/v1/assistants/:assistant_id',
    async (request, reply) => {
      const assistant = adapter.getAssistant(request.params.assistant_id);

      if (!assistant) {
        return reply.status(404).send({
          error: {
            message: `No assistant found with id '${request.params.assistant_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(assistant);
    }
  );

  fastify.post<{ Params: { assistant_id: string }; Body: UpdateAssistantRequest }>(
    '/v1/assistants/:assistant_id',
    async (request, reply) => {
      const assistant = adapter.updateAssistant(
        request.params.assistant_id,
        request.body
      );

      if (!assistant) {
        return reply.status(404).send({
          error: {
            message: `No assistant found with id '${request.params.assistant_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send(assistant);
    }
  );

  fastify.delete<{ Params: { assistant_id: string } }>(
    '/v1/assistants/:assistant_id',
    async (request, reply) => {
      const deleted = adapter.deleteAssistant(request.params.assistant_id);

      if (!deleted) {
        return reply.status(404).send({
          error: {
            message: `No assistant found with id '${request.params.assistant_id}'`,
            type: 'invalid_request_error',
            code: 'not_found',
          },
        });
      }

      return reply.send({
        id: request.params.assistant_id,
        object: 'assistant.deleted',
        deleted: true,
      });
    }
  );
}
