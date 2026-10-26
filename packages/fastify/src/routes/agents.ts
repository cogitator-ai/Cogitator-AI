import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preValidationAsyncHookHandler,
} from 'fastify';
import type { RunResult } from '@cogitator-ai/types';
import type { AgentListResponse, AgentResumeRequest, AgentRunRequest } from '../types.js';
import { AgentResumeRequestSchema, AgentRunRequestSchema } from '../types.js';
import {
  AgentStreamSession,
  lastEventIdOf,
  parseResumeRequest,
  parseRunRequest,
  runRequestRunOptions,
  toAgentRunResponse,
  type StreamFollower,
} from '@cogitator-ai/server-shared';
import { FastifyStreamWriter } from '../streaming/index.js';
import {
  onClientDisconnect,
  refuseThread,
  requestDeps,
  resolveError,
  sendError,
  sendFailure,
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

/** What the stream routes document of a reconnect, where streams are resumable */
const reconnectSchema = {
  headers: {
    type: 'object',
    properties: {
      'last-event-id': {
        type: 'string',
        description:
          'Reconnect to the stream of a run instead of starting one: the `id` of the last event the client got (`<streamId>:<seq>`). The answer replays the events after it, then follows the run to its end. The body is not read',
      },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      lastEventId: {
        type: 'string',
        description: 'The same as the `Last-Event-ID` header, for clients that cannot set it',
      },
    },
  },
} as const;

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  const runBody = validateBody((body) =>
    parseRunRequest(body, { acceptContext: fastify.cogitator.acceptContext })
  );
  const resumeBody = validateBody(parseResumeRequest);

  const findAgent = (name: string) =>
    Object.hasOwn(fastify.cogitator.agents, name) ? fastify.cogitator.agents[name] : undefined;

  const streams = fastify.cogitator.resumableStreams;

  /** Writes the frames of a resumable stream to one client, until it ends or the client leaves */
  const followStream = async (reply: FastifyReply, stream: StreamFollower) => {
    const writer = new FastifyStreamWriter(reply, {
      heartbeatMs: fastify.cogitator.sseHeartbeatMs,
    });
    writer.open();
    const client = new AbortController();
    onClientDisconnect(reply, () => {
      client.abort();
      writer.close();
    });
    try {
      for await (const frame of stream.frames(client.signal)) writer.send(frame.event, frame.id);
    } finally {
      writer.close();
    }
    return reply;
  };

  /**
   * The `preValidation` hook of the stream routes where streams are resumable: answers a
   * request with `Last-Event-ID` or `?lastEventId=` by reconnecting it to its stream, before the
   * body is validated, since a reconnect needs none
   */
  const reconnect: preValidationAsyncHookHandler = async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const lastEventId = lastEventIdOf(request.headers['last-event-id'], query?.lastEventId);
    if (!streams || lastEventId === undefined) return;
    const { name } = request.params as AgentParams;
    if (!findAgent(name)) return sendError(reply, 404, `Agent '${name}' not found`, 'NOT_FOUND');
    const attached = await streams.reconnect(lastEventId, request.cogitatorAuth?.userId);
    if (!attached.ok) return sendFailure(reply, attached.error);
    return followStream(reply, attached.stream);
  };

  const streamRouteSchema = streams ? reconnectSchema : {};

  const streamAgent = async (
    request: FastifyRequest,
    reply: FastifyReply,
    threadId: string | undefined,
    errorLabel: string,
    execute: (session: AgentStreamSession, signal: AbortSignal) => Promise<RunResult>
  ) => {
    if (streams) {
      let stream: StreamFollower;
      try {
        stream = await streams.startAgentRun({
          userId: request.cogitatorAuth?.userId,
          threadId,
          execute,
          describeError: (error) => resolveError(request, error, errorLabel),
        });
      } catch (error) {
        return sendRouteError(request, reply, error, errorLabel);
      }
      return followStream(reply, stream);
    }

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
    {
      schema: { params: paramsSchema, body: AgentRunRequestSchema, ...streamRouteSchema },
      preValidation: [reconnect, runBody],
    },
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
    {
      schema: { params: paramsSchema, body: AgentResumeRequestSchema, ...streamRouteSchema },
      preValidation: [reconnect, resumeBody],
    },
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
