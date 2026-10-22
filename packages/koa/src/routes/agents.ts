import Router from '@koa/router';
import type { ParameterizedContext } from 'koa';
import type { RunResult } from '@cogitator-ai/types';
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

async function streamAgent(
  ctx: ParameterizedContext<CogitatorState>,
  threadId: string | undefined,
  errorLabel: string,
  execute: (session: AgentStreamSession, signal: AbortSignal) => Promise<RunResult>
): Promise<void> {
  setupSSEHeaders(ctx);
  const writer = new KoaStreamWriter(ctx, {
    heartbeatMs: ctx.state.cogitator.sseHeartbeatMs,
  });
  const session = new AgentStreamSession((event) => writer.send(event), { threadId });
  const abortController = new AbortController();

  onClientDisconnect(ctx, () => {
    writer.close();
    abortController.abort();
  });

  session.start();

  try {
    session.complete(await execute(session, abortController.signal));
  } catch (error) {
    if (!abortController.signal.aborted) {
      const failure = describeError(error, errorLabel);
      session.fail(failure.message, failure.code);
    }
  } finally {
    writer.close();
  }
}

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

    await streamAgent(ctx, parsed.value.threadId, 'Agent stream error', (session, signal) =>
      runtime.run(agent, {
        ...parsed.value,
        threadId: session.threadId,
        userId: ctx.state.auth?.userId,
        ...deps,
        stream: true,
        signal,
        ...session.callbacks,
      })
    );
  });

  router.post('/agents/:name/resume/stream', async (ctx) => {
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

    await streamAgent(ctx, threadId, 'Agent resume stream error', (session, signal) =>
      runtime.resume(agent, threadId, {
        userId: ctx.state.auth?.userId,
        ...deps,
        decisions,
        defaultDecision,
        stream: true,
        signal,
        ...session.callbacks,
      })
    );
  });

  return router;
}
