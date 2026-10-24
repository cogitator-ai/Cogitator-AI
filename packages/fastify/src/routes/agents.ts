import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { RunResult } from '@cogitator-ai/types';
import type { AgentListResponse, AgentResumeRequest, AgentRunRequest } from '../types.js';
import { AgentResumeRequestSchema, AgentRunRequestSchema } from '../types.js';
import {
  AgentStreamSession,
  parseResumeRequest,
  parseRunRequest,
  runRequestRunOptions,
  toAgentRunResponse,
} from '@cogitator-ai/server-shared';
import { FastifyStreamWriter } from '../streaming/index.js';
import {
  onClientDisconnect,
  refuseThread,
  requestDeps,
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

  const streamAgent = async (
    request: FastifyRequest,
    reply: FastifyReply,
    threadId: string | undefined,
    errorLabel: string,
    execute: (session: AgentStreamSession, signal: AbortSignal) => Promise<RunResult>
  ) => {
    const writer = new FastifyStreamWriter(reply, {
      heartbeatMs: fastify.cogitator.sseHeartbeatMs,
    });
    const session = new AgentStreamSession((event) => writer.send(event), { threadId });
    const abortController = new AbortController();

    onClientDisconnect(reply, () => {
      abortController.abort();
      writer.close();
    });

    try {
      session.start();
      session.complete(await execute(session, abortController.signal));
    } catch (error) {
      if (!abortController.signal.aborted) {
        const resolved = resolveError(request, error, errorLabel);
        session.fail(resolved.message, resolved.code);
      }
    } finally {
      writer.close();
    }

    return reply;
  };

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

      if (await refuseThread(request, reply, request.body.threadId)) return reply;
      const deps = await requestDeps(request);

      const abortController = new AbortController();
      onClientDisconnect(reply, () => abortController.abort());

      try {
        const result = await fastify.cogitator.runtime.run(agent, {
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
          ...runRequestRunOptions(request.body),
          userId: request.cogitatorAuth?.userId,
          signal: abortController.signal,
          ...deps,
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

      if (await refuseThread(request, reply, request.body.threadId)) return reply;
      const deps = await requestDeps(request);

      const abortController = new AbortController();
      onClientDisconnect(reply, () => abortController.abort());

      try {
        const result = await fastify.cogitator.runtime.resume(agent, request.body.threadId, {
          userId: request.cogitatorAuth?.userId,
          decisions: request.body.decisions,
          defaultDecision: request.body.defaultDecision,
          responses: request.body.responses,
          signal: abortController.signal,
          ...deps,
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

      if (await refuseThread(request, reply, request.body.threadId)) return reply;
      const deps = await requestDeps(request);

      return streamAgent(
        request,
        reply,
        request.body.threadId,
        'agent stream error',
        (session, signal) =>
          fastify.cogitator.runtime.run(agent, {
            input: request.body.input,
            context: request.body.context,
            threadId: session.threadId,
            ...runRequestRunOptions(request.body),
            userId: request.cogitatorAuth?.userId,
            signal,
            stream: true,
            ...session.callbacks,
            ...deps,
          })
      );
    }
  );

  fastify.post<{ Params: AgentParams; Body: AgentResumeRequest }>(
    '/agents/:name/resume/stream',
    { schema: { params: paramsSchema, body: AgentResumeRequestSchema }, preValidation: resumeBody },
    async (request, reply) => {
      const { name } = request.params;
      const agent = findAgent(name);

      if (!agent) {
        return sendError(reply, 404, `Agent '${name}' not found`, 'NOT_FOUND');
      }

      const { threadId, decisions, defaultDecision, responses } = request.body;
      if (await refuseThread(request, reply, threadId)) return reply;
      const deps = await requestDeps(request);

      return streamAgent(request, reply, threadId, 'agent resume stream error', (session, signal) =>
        fastify.cogitator.runtime.resume(agent, threadId, {
          userId: request.cogitatorAuth?.userId,
          decisions,
          defaultDecision,
          responses,
          signal,
          stream: true,
          ...session.callbacks,
          ...deps,
        })
      );
    }
  );
};
