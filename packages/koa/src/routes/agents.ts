import Router from '@koa/router';
import type { CogitatorState, AgentListResponse, AgentRunResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { generateId } from '@cogitator-ai/server-shared';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { resolveError } from '../utils/errors.js';
import { getRequestBody, onClientDisconnect } from '../utils/request.js';
import { parseAgentRunRequest } from '../utils/validation.js';

export function createAgentRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/agents', (ctx) => {
    const { agents } = ctx.state.cogitator;
    const agentList = Object.entries(agents).map(([name, agent]) => ({
      name,
      description: agent.config.description,
      tools: agent.config.tools?.map((t) => t.name) ?? [],
    }));

    const response: AgentListResponse = { agents: agentList };
    ctx.body = response;
  });

  router.post('/agents/:name/run', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = getOwn(agents, name);

    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseAgentRunRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    const abortController = new AbortController();
    onClientDisconnect(ctx, () => abortController.abort());

    try {
      const result = await runtime.run(agent, {
        ...parsed.value,
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

      ctx.body = response;
    } catch (error) {
      if (abortController.signal.aborted) return;
      const { status, body } = resolveError(error, 'Agent run error');
      ctx.status = status;
      ctx.body = body;
    }
  });

  router.post('/agents/:name/stream', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = getOwn(agents, name);

    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseAgentRunRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx);
    const messageId = generateId('msg');
    const textId = generateId('txt');
    const abortController = new AbortController();

    onClientDisconnect(ctx, () => {
      writer.close();
      abortController.abort();
    });

    writer.start(messageId);
    writer.textStart(textId);

    try {
      const result = await runtime.run(agent, {
        ...parsed.value,
        stream: true,
        signal: abortController.signal,
        onToken: (token: string) => {
          writer.textDelta(textId, token);
        },
        onToolCall: (toolCall: ToolCall) => {
          writer.toolCallStart(toolCall.id, toolCall.name);
          writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
          writer.toolCallEnd(toolCall.id);
        },
        onToolResult: (toolResult: ToolResult) => {
          writer.toolResult(generateId('res'), toolResult.callId, toolResult.result);
        },
      });

      writer.textEnd(textId);
      writer.finish(messageId, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        writer.textEnd(textId);
        const { body } = resolveError(error, 'Agent stream error');
        writer.error(body.error.message, body.error.code);
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
