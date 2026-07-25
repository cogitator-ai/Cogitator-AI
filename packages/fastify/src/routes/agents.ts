import type { FastifyPluginAsync } from 'fastify';
import type { AgentListResponse, AgentRunRequest, AgentRunResponse } from '../types.js';
import { AgentRunRequestSchema } from '../types.js';
import { FastifyStreamWriter, generateId } from '../streaming/index.js';
import { CogitatorError, type ToolCall } from '@cogitator-ai/types';

interface AgentParams {
  name: string;
}

export const agentRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/agents', async () => {
    const agentList = Object.entries(fastify.cogitator.agents).map(([name, agent]) => ({
      name,
      description: agent.config.instructions?.slice(0, 100),
      tools: agent.config.tools?.map((t) => t.name) || [],
    }));

    const response: AgentListResponse = { agents: agentList };
    return response;
  });

  fastify.post<{ Params: AgentParams; Body: AgentRunRequest }>(
    '/agents/:name/run',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: AgentRunRequestSchema,
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const agent = Object.hasOwn(fastify.cogitator.agents, name)
        ? fastify.cogitator.agents[name]
        : undefined;

      if (!agent) {
        return reply.status(404).send({
          error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      try {
        const result = await fastify.cogitator.runtime.run(agent, {
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
        });

        const response: AgentRunResponse = {
          output: result.output,
          threadId: result.threadId,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          },
          toolCalls: [...result.toolCalls],
        };

        return response;
      } catch (error) {
        if (CogitatorError.isCogitatorError(error)) {
          return reply.status(500).send({ error: { message: error.message, code: error.code } });
        }
        request.log.error({ err: error }, 'agent run error');
        return reply
          .status(500)
          .send({ error: { message: 'Internal server error', code: 'INTERNAL' } });
      }
    }
  );

  fastify.post<{ Params: AgentParams; Body: AgentRunRequest }>(
    '/agents/:name/stream',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        body: AgentRunRequestSchema,
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const agent = Object.hasOwn(fastify.cogitator.agents, name)
        ? fastify.cogitator.agents[name]
        : undefined;

      if (!agent) {
        return reply.status(404).send({
          error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' },
        });
      }

      const writer = new FastifyStreamWriter(reply);
      const messageId = generateId('msg');
      const textId = generateId('txt');
      let textStarted = false;

      request.raw.on('close', () => {
        writer.close();
      });

      try {
        writer.start(messageId);
        writer.textStart(textId);
        textStarted = true;

        const result = await fastify.cogitator.runtime.run(agent, {
          input: request.body.input,
          context: request.body.context,
          threadId: request.body.threadId,
          stream: true,
          onToken: (token: string) => {
            writer.textDelta(textId, token);
          },
          onToolCall: (toolCall: ToolCall) => {
            const toolId = generateId('tool');
            writer.toolCallStart(toolId, toolCall.name);
            writer.toolCallEnd(toolId);
          },
          onToolResult: (toolResult: { callId: string; result: unknown }) => {
            const resultId = generateId('res');
            writer.toolResult(resultId, toolResult.callId, toolResult.result);
          },
        });

        writer.textEnd(textId);
        writer.finish(messageId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });
      } catch (error) {
        if (textStarted) writer.textEnd(textId);
        if (CogitatorError.isCogitatorError(error)) {
          writer.error(error.message, error.code);
        } else {
          request.log.error({ err: error }, 'agent stream error');
          writer.error('Internal server error', 'INTERNAL');
        }
      } finally {
        writer.close();
      }
    }
  );
};
