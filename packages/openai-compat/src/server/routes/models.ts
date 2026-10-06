/**
 * Models API: the registered agents, which the Chat Completions and Responses endpoints take as
 * `model`, and the `cogitator` model of the Assistants API.
 */

import type { FastifyInstance } from 'fastify';
import { COGITATOR_MODEL_ID } from '../../client/openai-adapter';
import type { AgentDirectory } from '../agents/shared';
import { sendNotFound } from './shared';

interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export function registerModelRoutes(fastify: FastifyInstance, directory: AgentDirectory) {
  const models = (): ModelObject[] => {
    const ids = [...directory.names()];
    if (!ids.includes(COGITATOR_MODEL_ID)) ids.push(COGITATOR_MODEL_ID);
    return ids.map((id) => ({
      id,
      object: 'model',
      created: directory.createdAt,
      owned_by: 'cogitator',
    }));
  };

  fastify.get('/v1/models', async () => ({ object: 'list', data: models() }));

  fastify.get<{ Params: { model: string } }>('/v1/models/:model', async (request, reply) => {
    const model = models().find((candidate) => candidate.id === request.params.model);
    if (!model) return sendNotFound(reply, 'model', request.params.model);
    return reply.send(model);
  });
}
