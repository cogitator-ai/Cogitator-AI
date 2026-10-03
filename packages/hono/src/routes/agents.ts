import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, AgentListResponse } from '../types.js';
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
import { toAgentRunResponse } from '../utils/results.js';
import { parseAgentResumeRequest, parseAgentRunRequest } from '../utils/validation.js';

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

      return c.json(toAgentRunResponse(result));
    } catch (error) {
      if (abortController.signal.aborted) return requestAborted(c);
      return errorResponse(c, error, 'Agent run error');
    }
  });

  app.post('/agents/:name/resume', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = getOwn(ctx.agents, name);

    if (!agent) {
      return c.json({ error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseAgentResumeRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const { threadId, decisions, defaultDecision } = parsed.value;
    const userId = c.get('cogitatorAuth')?.userId;
    const abortController = createRequestAbortController(c);

    try {
      const result = await ctx.runtime.resume(agent, threadId, {
        userId,
        decisions,
        defaultDecision,
        signal: abortController.signal,
      });

      return c.json(toAgentRunResponse(result));
    } catch (error) {
      if (abortController.signal.aborted) return requestAborted(c);
      return errorResponse(c, error, 'Agent resume error');
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

      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });

      let textId: string | null = null;
      let reasoningId: string | null = null;
      let streamedText = false;

      const endText = () => {
        if (textId === null) return;
        void writer.textEnd(textId);
        textId = null;
      };

      const endReasoning = () => {
        if (reasoningId === null) return;
        void writer.reasoningEnd(reasoningId);
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
          void writer.textStart(textId);
        }
        void writer.textDelta(textId, delta);
      };

      const writeReasoning = (delta: string) => {
        if (!delta) return;
        if (reasoningId === null) {
          endText();
          reasoningId = generateId('rsn');
          void writer.reasoningStart(reasoningId);
        }
        void writer.reasoningDelta(reasoningId, delta);
      };

      try {
        await writer.start(messageId);

        const result = await ctx.runtime.run(agent, {
          ...parsed.value,
          userId,
          stream: true,
          signal: abortController.signal,
          onToken: (token: string) => {
            if (token) streamedText = true;
            writeText(token);
          },
          onReasoning: writeReasoning,
          onToolCall: (toolCall: ToolCall) => {
            endParts();
            void writer.toolCallStart(toolCall.id, toolCall.name);
            void writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
            void writer.toolCallEnd(toolCall.id);
          },
          onToolResult: (toolResult: ToolResult) => {
            void writer.toolResult(generateId('res'), toolResult.callId, toolResult.result);
          },
        });

        if (!streamedText) writeText(result.output);
        endParts();
        if (result.status === 'paused' && result.pendingApprovals) {
          await writer.approvalRequired(result.threadId, result.pendingApprovals);
        }
        await writer.finish(messageId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });
      } catch (error) {
        if (abortController.signal.aborted) return;
        endParts();
        const { body: errorBody } = resolveError(error, 'Agent stream error');
        await writer.error(errorBody.error.message, errorBody.error.code);
      } finally {
        writer.close();
      }
    });
  });

  return app;
}
