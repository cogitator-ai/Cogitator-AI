import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  AgentStreamSession,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
} from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, AgentListResponse } from '../types.js';
import { getOwn } from '../utils/lookup.js';
import { resolveError } from '../utils/errors.js';
import {
  createRequestAbortController,
  holdConnectionOpen,
  errorResponse,
  invalidInput,
  bodyRefused,
  readJsonBody,
  requestAborted,
} from '../utils/request.js';

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
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseRunRequest(body.value, { acceptContext: ctx.acceptContext });
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const userId = c.get('cogitatorAuth')?.userId;
    holdConnectionOpen(c);
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
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseResumeRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const { threadId, decisions, defaultDecision } = parsed.value;
    const userId = c.get('cogitatorAuth')?.userId;
    holdConnectionOpen(c);
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
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseRunRequest(body.value, { acceptContext: ctx.acceptContext });
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const userId = c.get('cogitatorAuth')?.userId;
    const abortController = createRequestAbortController(c);

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream, { heartbeatMs: ctx.sseHeartbeatMs });
      const session = new AgentStreamSession((event) => void writer.send(event), {
        threadId: parsed.value.threadId,
      });

      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });

      try {
        session.start();
        const result = await ctx.runtime.run(agent, {
          ...parsed.value,
          threadId: session.threadId,
          userId,
          stream: true,
          signal: abortController.signal,
          ...session.callbacks,
        });
        session.complete(result);
      } catch (error) {
        if (abortController.signal.aborted) return;
        const { body: errorBody } = resolveError(error, 'Agent stream error');
        session.fail(errorBody.error.message, errorBody.error.code);
      } finally {
        await writer.flush();
        writer.close();
      }
    });
  });

  return app;
}
