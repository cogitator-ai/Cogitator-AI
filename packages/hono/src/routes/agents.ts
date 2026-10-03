import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, AgentListResponse, AgentRunResponse } from '../types.js';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { resolveError } from '../utils/errors.js';
import {
  createRequestAbortController,
  errorResponse,
  invalidInput,
  invalidJson,
  readJsonBody,
  requestAborted,
} from '../utils/request.js';
import { parseAgentRunRequest } from '../utils/validation.js';

export function createAgentRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/agents', (c) => {
    const ctx = c.get('cogitator');
    const agentList = Object.entries(ctx.agents).map(([name, agent]) => ({
      name,
      description: agent.config.description,
      tools: agent.config.tools?.map((t) => t.name) ?? [],
    }));

    const response: AgentListResponse = { agents: agentList };
    return c.json(response);
  });

  app.post('/agents/:name/run', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = getOwn(ctx.agents, name);

    if (!agent) {
      return c.json({ error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseAgentRunRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const userId = c.get('cogitatorAuth')?.userId;
    const abortController = createRequestAbortController(c);

    try {
      const result = await ctx.runtime.run(agent, {
        ...parsed.value,
        userId,
        signal: abortController.signal,
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

      return c.json(response);
    } catch (error) {
      if (abortController.signal.aborted) return requestAborted(c);
      return errorResponse(c, error, 'Agent run error');
    }
  });

  app.post('/agents/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = getOwn(ctx.agents, name);

    if (!agent) {
      return c.json({ error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseAgentRunRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const userId = c.get('cogitatorAuth')?.userId;
    const abortController = createRequestAbortController(c);

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream);
      const messageId = generateId('msg');
      const textId = generateId('txt');

      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });

      try {
        await writer.start(messageId);
        await writer.textStart(textId);

        const result = await ctx.runtime.run(agent, {
          ...parsed.value,
          userId,
          stream: true,
          signal: abortController.signal,
          onToken: (token: string) => {
            void writer.textDelta(textId, token);
          },
          onToolCall: (toolCall: ToolCall) => {
            void writer.toolCallStart(toolCall.id, toolCall.name);
            void writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
            void writer.toolCallEnd(toolCall.id);
          },
          onToolResult: (toolResult: ToolResult) => {
            void writer.toolResult(generateId('res'), toolResult.callId, toolResult.result);
          },
        });

        await writer.textEnd(textId);
        await writer.finish(messageId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });
      } catch (error) {
        if (abortController.signal.aborted) return;
        await writer.textEnd(textId);
        const { body: errorBody } = resolveError(error, 'Agent stream error');
        await writer.error(errorBody.error.message, errorBody.error.code);
      } finally {
        writer.close();
      }
    });
  });

  return app;
}
