import Router from '@koa/router';
import type { CogitatorState, AgentListResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { generateId } from '@cogitator-ai/server-shared';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { getOwn } from '../utils/lookup.js';
import { resolveError } from '../utils/errors.js';
import { getRequestBody, onClientDisconnect } from '../utils/request.js';
import { toAgentRunResponse } from '../utils/results.js';
import { parseAgentResumeRequest, parseAgentRunRequest } from '../utils/validation.js';

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
        userId: ctx.state.auth?.userId,
        signal: abortController.signal,
      });

      ctx.body = toAgentRunResponse(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const { status, body } = resolveError(error, 'Agent run error');
      ctx.status = status;
      ctx.body = body;
    }
  });

  router.post('/agents/:name/resume', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = getOwn(agents, name);

    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const parsed = parseAgentResumeRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }
    const { threadId, decisions, defaultDecision } = parsed.value;

    const abortController = new AbortController();
    onClientDisconnect(ctx, () => abortController.abort());

    try {
      const result = await runtime.resume(agent, threadId, {
        userId: ctx.state.auth?.userId,
        decisions,
        defaultDecision,
        signal: abortController.signal,
      });

      ctx.body = toAgentRunResponse(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const { status, body } = resolveError(error, 'Agent resume error');
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
    const abortController = new AbortController();

    onClientDisconnect(ctx, () => {
      writer.close();
      abortController.abort();
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

    writer.start(messageId);

    try {
      const result = await runtime.run(agent, {
        ...parsed.value,
        userId: ctx.state.auth?.userId,
        stream: true,
        signal: abortController.signal,
        onToken: (token: string) => {
          if (token) streamedText = true;
          writeText(token);
        },
        onReasoning: writeReasoning,
        onToolCall: (toolCall: ToolCall) => {
          endParts();
          writer.toolCallStart(toolCall.id, toolCall.name);
          writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
          writer.toolCallEnd(toolCall.id);
        },
        onToolResult: (toolResult: ToolResult) => {
          writer.toolResult(generateId('res'), toolResult.callId, toolResult.result);
        },
      });

      if (!streamedText) writeText(result.output);
      endParts();
      if (result.status === 'paused' && result.pendingApprovals) {
        writer.approvalRequired(result.threadId, result.pendingApprovals);
      }
      writer.finish(messageId, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        endParts();
        const { body } = resolveError(error, 'Agent stream error');
        writer.error(body.error.message, body.error.code);
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
