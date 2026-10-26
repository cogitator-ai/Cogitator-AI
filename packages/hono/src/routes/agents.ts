import { Hono } from 'hono';
import type { Context } from 'hono';
import type { RunResult } from '@cogitator-ai/types';
import { streamSSE } from 'hono/streaming';
import {
  AgentStreamSession,
  lastEventIdOf,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
  type StreamFollower,
} from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, AgentListResponse } from '../types.js';
import { getOwn } from '../utils/lookup.js';
import { describeError } from '../utils/errors.js';
import {
  createRequestAbortController,
  holdConnectionOpen,
  errorResponse,
  invalidInput,
  bodyRefused,
  notFound,
  readJsonBody,
  refuseThread,
  requestAborted,
  runDeps,
  sendError,
} from '../utils/request.js';

/** Writes the frames of a resumable stream to one client, until it ends or the client leaves */
function followStream(c: Context<HonoEnv>, stream: StreamFollower): Response {
  const client = createRequestAbortController(c);

  return streamSSE(c, async (sse) => {
    const writer = new HonoStreamWriter(sse, { heartbeatMs: c.get('cogitator').sseHeartbeatMs });
    sse.onAbort(() => {
      writer.close();
      client.abort();
    });

    try {
      for await (const frame of stream.frames(client.signal)) {
        await writer.send(frame.event, frame.id);
      }
    } finally {
      await writer.flush();
      writer.close();
    }
  });
}

/**
 * The answer to a request that reconnects to a resumable stream with `Last-Event-ID` or
 * `?lastEventId=`, `undefined` for a request that is no reconnect
 */
async function reconnect(c: Context<HonoEnv>): Promise<Response | undefined> {
  const streams = c.get('cogitator').resumableStreams;
  const lastEventId =
    streams && lastEventIdOf(c.req.header('last-event-id'), c.req.queries('lastEventId'));
  if (!streams || lastEventId === undefined) return undefined;
  const attached = await streams.reconnect(lastEventId, c.get('cogitatorAuth')?.userId);
  return attached.ok ? followStream(c, attached.stream) : sendError(c, attached.error);
}

async function streamAgent(
  c: Context<HonoEnv>,
  threadId: string | undefined,
  errorLabel: string,
  execute: (session: AgentStreamSession, signal: AbortSignal) => Promise<RunResult>
): Promise<Response> {
  const streams = c.get('cogitator').resumableStreams;
  if (streams) {
    const stream = await streams.startAgentRun({
      userId: c.get('cogitatorAuth')?.userId,
      threadId,
      execute,
      describeError: (error) => describeError(error, errorLabel),
    });
    return followStream(c, stream);
  }

  const abortController = createRequestAbortController(c);

  return streamSSE(c, async (stream) => {
    const writer = new HonoStreamWriter(stream, { heartbeatMs: c.get('cogitator').sseHeartbeatMs });
    const session = new AgentStreamSession((event) => void writer.send(event), { threadId });

    stream.onAbort(() => {
      writer.close();
      abortController.abort();
    });

    try {
      session.start();
      session.complete(await execute(session, abortController.signal));
    } catch (error) {
      if (abortController.signal.aborted) return;
      const failure = describeError(error, errorLabel);
      session.fail(failure.message, failure.code);
    } finally {
      await writer.flush();
      writer.close();
    }
  });
}

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

    if (!agent) return notFound(c, `Agent '${name}' not found`);

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseRunRequest(body.value, { acceptContext: ctx.acceptContext });
    if (!parsed.ok) return invalidInput(c, parsed.message);
    const refusal = await refuseThread(c, parsed.value.threadId);
    if (refusal) return sendError(c, refusal);

    const userId = c.get('cogitatorAuth')?.userId;
    const deps = await runDeps(c);
    holdConnectionOpen(c);
    const abortController = createRequestAbortController(c);

    try {
      const result = await ctx.runtime.run(agent, {
        ...parsed.value,
        userId,
        ...deps,
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

    if (!agent) return notFound(c, `Agent '${name}' not found`);

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseResumeRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const { threadId, decisions, defaultDecision, responses } = parsed.value;
    const refusal = await refuseThread(c, threadId);
    if (refusal) return sendError(c, refusal);

    const userId = c.get('cogitatorAuth')?.userId;
    const deps = await runDeps(c);
    holdConnectionOpen(c);
    const abortController = createRequestAbortController(c);

    try {
      const result = await ctx.runtime.resume(agent, threadId, {
        userId,
        ...deps,
        decisions,
        defaultDecision,
        responses,
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

    if (!agent) return notFound(c, `Agent '${name}' not found`);

    const reconnected = await reconnect(c);
    if (reconnected) return reconnected;

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseRunRequest(body.value, { acceptContext: ctx.acceptContext });
    if (!parsed.ok) return invalidInput(c, parsed.message);
    const refusal = await refuseThread(c, parsed.value.threadId);
    if (refusal) return sendError(c, refusal);

    const userId = c.get('cogitatorAuth')?.userId;
    const deps = await runDeps(c);

    return streamAgent(c, parsed.value.threadId, 'Agent stream error', (session, signal) =>
      ctx.runtime.run(agent, {
        ...parsed.value,
        threadId: session.threadId,
        userId,
        ...deps,
        stream: true,
        signal,
        ...session.callbacks,
      })
    );
  });

  app.post('/agents/:name/resume/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = getOwn(ctx.agents, name);

    if (!agent) return notFound(c, `Agent '${name}' not found`);

    const reconnected = await reconnect(c);
    if (reconnected) return reconnected;

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseResumeRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const { threadId, decisions, defaultDecision, responses } = parsed.value;
    const refusal = await refuseThread(c, threadId);
    if (refusal) return sendError(c, refusal);

    const userId = c.get('cogitatorAuth')?.userId;
    const deps = await runDeps(c);

    return streamAgent(c, threadId, 'Agent resume stream error', (session, signal) =>
      ctx.runtime.resume(agent, threadId, {
        userId,
        ...deps,
        decisions,
        defaultDecision,
        responses,
        stream: true,
        signal,
        ...session.callbacks,
      })
    );
  });

  return app;
}
