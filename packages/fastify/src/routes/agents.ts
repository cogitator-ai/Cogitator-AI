import type { FastifyPluginAsync } from 'fastify';
import type { AgentListResponse, AgentResumeRequest, AgentRunRequest } from '../types.js';
import { AgentResumeRequestSchema, AgentRunRequestSchema } from '../types.js';
import {
  AgentStreamSession,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
} from '@cogitator-ai/server-shared';
import { FastifyStreamWriter } from '../streaming/index.js';
import {
  onClientDisconnect,
  resolveError,
  sendError,
  sendRouteError,
  validateBody,
} from './utils.js';

interface AgentParams {
  name: string;
}

const paramsSchema = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const;

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  const runBody = validateBody((body) =>
    parseRunRequest(body, { acceptContext: fastify.cogitator.acceptContext })
  );
  const resumeBody = validateBody(parseResumeRequest);

  const findAgent = (name: string) =>
    Object.hasOwn(fastify.cogitator.agents, name) ? fastify.cogitator.agents[name] : undefined;

  fastify.get('/agents', async () => {
    const agentList = Object.entries(fastify.cogitator.agents).map(([name, agent]) => ({
      name,
      description: agent.config.description,
      tools: agent.config.tools?.map((t) => t.name) || [],
    }));

    const response: AgentListResponse = { agents: agentList };
    return response;
  });

  fastify.post<{ Params: AgentParams; Body: AgentRunRequest }>(
    '/agents/:name/run',
    { schema: { params: paramsSchema, body: AgentRunRequestSchema }, preValidation: runBody },
    async (request, reply) => {
      const { name } = request.params;
      const agent = findAgent(name);

      if (!agent) {
        return sendError(reply, 404, `Agent '${name}' not found`, 'NOT_FOUND');
      }

      const abortController = new AbortController();
      onClientDisconnect(reply, () => abortController.abort());

      try {
        const result = await fastify.cogitator.runtime.run(agent, {
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
          userId: request.cogitatorAuth?.userId,
          signal: abortController.signal,
        });

        return toAgentRunResponse(result);
      } catch (error) {
        return sendRouteError(request, reply, error, 'agent run error');
      }
    }
  );

  fastify.post<{ Params: AgentParams; Body: AgentResumeRequest }>(
    '/agents/:name/resume',
    { schema: { params: paramsSchema, body: AgentResumeRequestSchema }, preValidation: resumeBody },
    async (request, reply) => {
      const { name } = request.params;
      const agent = findAgent(name);

      if (!agent) {
        return sendError(reply, 404, `Agent '${name}' not found`, 'NOT_FOUND');
      }

      const abortController = new AbortController();
      onClientDisconnect(reply, () => abortController.abort());

      try {
        const result = await fastify.cogitator.runtime.resume(agent, request.body.threadId, {
          userId: request.cogitatorAuth?.userId,
          decisions: request.body.decisions,
          defaultDecision: request.body.defaultDecision,
          signal: abortController.signal,
        });

        return toAgentRunResponse(result);
      } catch (error) {
        return sendRouteError(request, reply, error, 'agent resume error');
      }
    }
  );

  fastify.post<{ Params: AgentParams; Body: AgentRunRequest }>(
    '/agents/:name/stream',
    { schema: { params: paramsSchema, body: AgentRunRequestSchema }, preValidation: runBody },
    async (request, reply) => {
      const { name } = request.params;
      const agent = findAgent(name);

      if (!agent) {
        return sendError(reply, 404, `Agent '${name}' not found`, 'NOT_FOUND');
      }

      const writer = new FastifyStreamWriter(reply, {
        heartbeatMs: fastify.cogitator.sseHeartbeatMs,
      });
      const session = new AgentStreamSession((event) => writer.send(event), {
        threadId: request.body.threadId,
      });
      const abortController = new AbortController();

      onClientDisconnect(reply, () => {
        abortController.abort();
        writer.close();
      });

      try {
        session.start();
        const result = await fastify.cogitator.runtime.run(agent, {
          input: request.body.input,
          context: request.body.context,
          threadId: session.threadId,
          userId: request.cogitatorAuth?.userId,
          signal: abortController.signal,
          stream: true,
          ...session.callbacks,
        });
        session.complete(result);
      } catch (error) {
        if (!abortController.signal.aborted) {
          const resolved = resolveError(request, error, 'agent stream error');
          session.fail(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }

      return reply;
    }
  );
};
