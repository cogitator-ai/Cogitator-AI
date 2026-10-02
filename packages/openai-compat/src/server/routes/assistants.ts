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
import { paginate, parseLimit, parseOrder, sendInvalidRequest } from './shared';

export function registerAssistantRoutes(fastify: FastifyInstance, adapter: OpenAIAdapter) {
  fastify.post<{ Body: CreateAssistantRequest }>('/v1/assistants', async (request, reply) => {
    if (!request.body || typeof request.body.model !== 'string' || !request.body.model) {
      return sendInvalidRequest(reply, 'model is required', 'model');
    }
    const assistant = await adapter.createAssistant(request.body);
    return reply.status(201).send(assistant);
  });

  fastify.get<{
    Querystring: { limit?: string; order?: string; after?: string; before?: string };
  }>('/v1/assistants', async (request, reply) => {
    const limit = parseLimit(request.query.limit);
    if (limit === null)
      return sendInvalidRequest(reply, 'limit must be between 1 and 100', 'limit');
    const order = parseOrder(request.query.order);
    if (order === null) return sendInvalidRequest(reply, "order must be 'asc' or 'desc'", 'order');

    const assistants = await adapter.listAssistants();
    const sorted = assistants
      .map((assistant, index) => ({ assistant, index }))
      .sort((a, b) => a.assistant.created_at - b.assistant.created_at || a.index - b.index)
      .map(({ assistant }) => assistant);
    const ordered = order === 'asc' ? sorted : sorted.reverse();

    const response: ListResponse<Assistant> = {
      object: 'list',
      ...paginate(ordered, { limit, after: request.query.after, before: request.query.before }),
    };

    return reply.send(response);
  });

  fastify.get<{ Params: { assistant_id: string } }>(
    '/v1/assistants/:assistant_id',
    async (request, reply) => {
      const assistant = await adapter.getAssistant(request.params.assistant_id);

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
      const assistant = await adapter.updateAssistant(request.params.assistant_id, request.body);

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
      const deleted = await adapter.deleteAssistant(request.params.assistant_id);

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
