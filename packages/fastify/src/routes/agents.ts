import type { FastifyPluginAsync } from 'fastify';
import type { AgentListResponse, AgentResumeRequest, AgentRunRequest } from '../types.js';
import { AgentResumeRequestSchema, AgentRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import {
  onClientDisconnect,
  resolveError,
  sendError,
  sendRouteError,
  toAgentRunResponse,
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
    { schema: { params: paramsSchema, body: AgentRunRequestSchema } },
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
    { schema: { params: paramsSchema, body: AgentResumeRequestSchema } },
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
    { schema: { params: paramsSchema, body: AgentRunRequestSchema } },
    async (request, reply) => {
      const { name } = request.params;
      const agent = findAgent(name);

      if (!agent) {
        return sendError(reply, 404, `Agent '${name}' not found`, 'NOT_FOUND');
      }

      const writer = new FastifyStreamWriter(reply, {
        heartbeatMs: fastify.cogitator.sseHeartbeatMs,
      });
      const messageId = generateId('msg');
      const abortController = new AbortController();

      onClientDisconnect(reply, () => {
        abortController.abort();
        writer.close();
      });

      let textId: string | null = null;
      let reasoningId: string | null = null;
      let streamedText = false;

      const endText = () => {
        if (textId === null) return;
        writer.textEnd(textId);
        textId = null;
      };

      const endReasoning = () => {
        if (reasoningId === null) return;
        writer.reasoningEnd(reasoningId);
        reasoningId = null;
      };

      const endParts = () => {
        endReasoning();
        endText();
      };

      const writeText = (delta: string) => {
        if (!delta) return;
        if (textId === null) {
          endReasoning();
          textId = generateId('txt');
          writer.textStart(textId);
        }
        writer.textDelta(textId, delta);
      };

      const writeReasoning = (delta: string) => {
        if (!delta) return;
        if (reasoningId === null) {
          endText();
          reasoningId = generateId('rsn');
          writer.reasoningStart(reasoningId);
        }
        writer.reasoningDelta(reasoningId, delta);
      };

      try {
        writer.start(messageId);

        const result = await fastify.cogitator.runtime.run(agent, {
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
          userId: request.cogitatorAuth?.userId,
          signal: abortController.signal,
          stream: true,
          onToken: (token) => {
            if (token) streamedText = true;
            writeText(token);
          },
          onReasoning: writeReasoning,
          onToolCall: (toolCall) => {
            endParts();
            writer.toolCallStart(toolCall.id, toolCall.name);
            writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
            writer.toolCallEnd(toolCall.id);
          },
          onToolResult: (toolResult) => {
            writer.toolResult(generateId('res'), toolResult.callId, toolResult.result);
          },
        });

        if (!streamedText) writeText(result.output);
        endParts();
        if (result.status === 'paused' && result.pendingApprovals) {
          writer.approvalRequired(result.threadId, result.pendingApprovals);
        }
        writer.finish(messageId, result.usage);
      } catch (error) {
        if (!abortController.signal.aborted) {
          const resolved = resolveError(request, error, 'agent stream error');
          endParts();
          writer.error(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }

      return reply;
    }
  );
};
