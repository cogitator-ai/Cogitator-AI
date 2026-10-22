import Router from '@koa/router';
import type { CogitatorState, AgentListResponse } from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import {
  AgentStreamSession,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
} from '@cogitator-ai/server-shared';
import { getOwn } from '../utils/lookup.js';
import {
  describeError,
  invalidInput,
  notFound,
  respondWithError,
  sendError,
} from '../utils/errors.js';
import { getRequestBody, onClientDisconnect, refuseThread, runDeps } from '../utils/request.js';

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
      notFound(ctx, `Agent '${name}' not found`);
      return;
    }

    const parsed = parseRunRequest(getRequestBody(ctx), {
      acceptContext: ctx.state.cogitator.acceptContext,
    });
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }
    const refusal = await refuseThread(ctx, parsed.value.threadId);
    if (refusal) {
      sendError(ctx, refusal);
      return;
    }

    const deps = await runDeps(ctx);
    const abortController = new AbortController();
    onClientDisconnect(ctx, () => abortController.abort());

    try {
      const result = await runtime.run(agent, {
        ...parsed.value,
        userId: ctx.state.auth?.userId,
        ...deps,
        signal: abortController.signal,
      });

      ctx.body = toAgentRunResponse(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      respondWithError(ctx, error, 'Agent run error');
    }
  });

  router.post('/agents/:name/resume', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = getOwn(agents, name);

    if (!agent) {
      notFound(ctx, `Agent '${name}' not found`);
      return;
    }

    const parsed = parseResumeRequest(getRequestBody(ctx));
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }
    const { threadId, decisions, defaultDecision } = parsed.value;
    const refusal = await refuseThread(ctx, threadId);
    if (refusal) {
      sendError(ctx, refusal);
      return;
    }

    const deps = await runDeps(ctx);
    const abortController = new AbortController();
    onClientDisconnect(ctx, () => abortController.abort());

    try {
      const result = await runtime.resume(agent, threadId, {
        userId: ctx.state.auth?.userId,
        ...deps,
        decisions,
        defaultDecision,
        signal: abortController.signal,
      });

      ctx.body = toAgentRunResponse(result);
    } catch (error) {
      if (abortController.signal.aborted) return;
      respondWithError(ctx, error, 'Agent resume error');
    }
  });

  router.post('/agents/:name/stream', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = getOwn(agents, name);

    if (!agent) {
      notFound(ctx, `Agent '${name}' not found`);
      return;
    }

    const parsed = parseRunRequest(getRequestBody(ctx), {
      acceptContext: ctx.state.cogitator.acceptContext,
    });
    if (!parsed.ok) {
      invalidInput(ctx, parsed.message);
      return;
    }
    const refusal = await refuseThread(ctx, parsed.value.threadId);
    if (refusal) {
      sendError(ctx, refusal);
      return;
    }
    const deps = await runDeps(ctx);

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx, {
      heartbeatMs: ctx.state.cogitator.sseHeartbeatMs,
    });
    const session = new AgentStreamSession((event) => writer.send(event), {
      threadId: parsed.value.threadId,
    });
    const abortController = new AbortController();

    onClientDisconnect(ctx, () => {
      writer.close();
      abortController.abort();
    });

    session.start();

    try {
      const result = await runtime.run(agent, {
        ...parsed.value,
        threadId: session.threadId,
        userId: ctx.state.auth?.userId,
        ...deps,
        stream: true,
        signal: abortController.signal,
        ...session.callbacks,
      });
      session.complete(result);
    } catch (error) {
      if (!abortController.signal.aborted) {
        const failure = describeError(error, 'Agent stream error');
        session.fail(failure.message, failure.code);
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
