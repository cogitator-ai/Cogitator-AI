import { Hono } from 'hono';
import type { Context } from 'hono';
import type { RunResult } from '@cogitator-ai/types';
import { streamSSE } from 'hono/streaming';
import {
  AgentStreamSession,
  authorizeThreadAccess,
  lastEventIdOf,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
  type StreamCaller,
  type StreamFollower,
} from '@cogitator-ai/server-shared';
import { parseAGUIRunInput, streamAGUIRun } from '@cogitator-ai/server-shared/agui';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { AuthContext, HonoEnv, AgentListResponse } from '../types.js';
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
  const attached = await streams.reconnect(lastEventId, callerOf(c));
  return attached.ok ? followStream(c, attached.stream) : sendError(c, attached.error);
}

/** The caller of a reconnect or cancel, with `authorizeThread` for the stream's thread */
function callerOf(c: Context<HonoEnv>): StreamCaller<AuthContext> {
  const auth = c.get('cogitatorAuth');
  return { auth, authorizeThread: (threadId) => refuseThreadOf(c, auth, threadId) };
}

function refuseThreadOf(c: Context<HonoEnv>, auth: AuthContext | undefined, threadId: string) {
  return authorizeThreadAccess(c.get('cogitator').authorizeThread, auth, threadId);
}

async function streamAgent(
  c: Context<HonoEnv>,
  threadId: string | undefined,
  errorLabel: string,
  execute: (session: AgentStreamSession, signal: AbortSignal) => Promise<RunResult>
): Promise<Response> {
  const streams = c.get('cogitator').resumableStreams;
  if (streams) {
    const opened = await streams.startAgentRun({
      auth: c.get('cogitatorAuth'),
      threadId,
      execute,
      describeError: (error) => describeError(error, errorLabel),
    });
    return opened.ok ? followStream(c, opened.stream) : sendError(c, opened.error);
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

  app.delete('/agents/:name/stream/:streamId', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const streams = ctx.resumableStreams;
    if (!streams) return notFound(c, 'Not found');
    if (!getOwn(ctx.agents, name)) return notFound(c, `Agent '${name}' not found`);
    const cancelled = await streams.cancel(c.req.param('streamId'), callerOf(c));
    return cancelled.ok ? c.body(null, 204) : sendError(c, cancelled.error);
  });

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

  app.post('/agents/:name/agui', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = getOwn(ctx.agents, name);
    if (!agent) return notFound(c, `Agent '${name}' not found`);

    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseAGUIRunInput(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const threadId = parsed.value.input.threadId;
    const refusal = await refuseThread(c, threadId);
    if (refusal) return sendError(c, refusal);
    const userId = c.get('cogitatorAuth')?.userId;
    const deps = await runDeps(c);
    const abortController = createRequestAbortController(c);

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream, { heartbeatMs: ctx.sseHeartbeatMs });
      stream.onAbort(() => {
        writer.close();
        abortController.abort();
      });
      try {
        await streamAGUIRun({
          request: parsed.value,
          send: (event) => void writer.sendData(event),
          signal: abortController.signal,
          describeError: (error) => describeError(error, 'AG-UI run error'),
          host: {
            run: (options) => ctx.runtime.run(agent, { ...options, userId, ...deps }),
            resume: (options) =>
              ctx.runtime.resume(agent, threadId, { ...options, userId, ...deps }),
            pausedRun: () => ctx.runtime.pausedRun(threadId),
            cancelPause: (reason) => ctx.runtime.cancelPause(threadId, { userId, reason }),
          },
        });
      } finally {
        await writer.flush();
        writer.close();
      }
    });
  });

  return app;
}
