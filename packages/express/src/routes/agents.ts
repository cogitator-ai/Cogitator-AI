import { Router } from 'express';
import type { Response } from 'express';
import type { RunResult } from '@cogitator-ai/types';
import type { RouteContext, CogitatorRequest, AgentListResponse } from '../types.js';
import {
  AgentStreamSession,
  authorizeThreadAccess,
  lastEventIdOf,
  parseResumeRequest,
  parseRunRequest,
  runRequestRunOptions,
  toAgentRunResponse,
  type StreamCaller,
  type StreamFollower,
} from '@cogitator-ai/server-shared';
import type { AuthContext } from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import {
  admitAgentRun,
  handleRouteError,
  onClientDisconnect,
  resolveError,
  sendError,
  sendFailure,
} from './utils.js';

export function createAgentRoutes(ctx: RouteContext): Router {
  const router = Router();
  const runRequestOptions = { acceptContext: ctx.config.acceptContext };

  const findAgent = (name: string) =>
    Object.hasOwn(ctx.agents, name) ? ctx.agents[name] : undefined;

  /** Writes the frames of a resumable stream to one client, until it ends or the client leaves */
  const followStream = async (res: Response, stream: StreamFollower) => {
    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res, { heartbeatMs: ctx.config.sseHeartbeatMs });
    const client = new AbortController();
    onClientDisconnect(res, () => {
      client.abort();
      writer.close();
    });
    try {
      for await (const frame of stream.frames(client.signal)) writer.send(frame.event, frame.id);
    } finally {
      writer.close();
    }
  };

  /** The caller of a reconnect or cancel, with `authorizeThread` for the stream's thread */
  const callerOf = (req: CogitatorRequest<{ name: string }>): StreamCaller<AuthContext> => {
    const auth = req.cogitator?.auth;
    return {
      auth,
      authorizeThread: (threadId) =>
        authorizeThreadAccess(ctx.config.authorizeThread, auth, threadId),
    };
  };

  /**
   * Answers a request that reconnects to a resumable stream with `Last-Event-ID` or
   * `?lastEventId=`, and says whether it was one
   */
  const reconnect = async (req: CogitatorRequest<{ name: string }>, res: Response) => {
    const streams = ctx.resumableStreams;
    const lastEventId = streams && lastEventIdOf(req.get('last-event-id'), req.query.lastEventId);
    if (!streams || lastEventId === undefined) return false;
    try {
      const attached = await streams.reconnect(lastEventId, callerOf(req));
      if (attached.ok) await followStream(res, attached.stream);
      else sendFailure(res, attached.error);
    } catch (error) {
      handleRouteError(res, error, 'Agent stream reconnect error');
    }
    return true;
  };

  const streamAgent = async (
    req: CogitatorRequest<{ name: string }>,
    res: Response,
    threadId: string | undefined,
    errorLabel: string,
    execute: (session: AgentStreamSession, signal: AbortSignal) => Promise<RunResult>
  ) => {
    const streams = ctx.resumableStreams;
    if (streams) {
      try {
        const opened = await streams.startAgentRun({
          auth: req.cogitator?.auth,
          threadId,
          execute,
          describeError: (error) => resolveError(error, errorLabel),
        });
        if (!opened.ok) {
          sendFailure(res, opened.error);
          return;
        }
        await followStream(res, opened.stream);
      } catch (error) {
        handleRouteError(res, error, errorLabel);
      }
      return;
    }

    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res, { heartbeatMs: ctx.config.sseHeartbeatMs });
    const session = new AgentStreamSession((event) => writer.send(event), { threadId });
    const abortController = new AbortController();

    onClientDisconnect(res, () => {
      abortController.abort();
      writer.close();
    });

    try {
      session.start();
      session.complete(await execute(session, abortController.signal));
    } catch (error) {
      if (!abortController.signal.aborted) {
        const resolved = resolveError(error, errorLabel);
        session.fail(resolved.message, resolved.code);
      }
    } finally {
      writer.close();
    }
  };

  if (ctx.resumableStreams) {
    const streams = ctx.resumableStreams;
    router.delete(
      '/agents/:name/stream/:streamId',
      async (req: CogitatorRequest<{ name: string; streamId: string }>, res: Response) => {
        const { name, streamId } = req.params;
        if (!findAgent(name)) {
          sendError(res, 404, `Agent '${name}' not found`, 'NOT_FOUND');
          return;
        }
        try {
          const cancelled = await streams.cancel(streamId, callerOf(req));
          if (cancelled.ok) res.status(204).end();
          else sendFailure(res, cancelled.error);
        } catch (error) {
          handleRouteError(res, error, 'Agent stream cancel error');
        }
      }
    );
  }

  router.get('/agents', (_req, res) => {
    const agentList = Object.entries(ctx.agents).map(([name, agent]) => ({
      name,
      description: agent.config.description,
      tools: agent.config.tools?.map((t) => t.name) || [],
    }));

    const response: AgentListResponse = { agents: agentList };
    res.json(response);
  });

  router.post(
    '/agents/:name/run',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const agent = findAgent(name);

      if (!agent) {
        sendError(res, 404, `Agent '${name}' not found`, 'NOT_FOUND');
        return;
      }

      const parsed = parseRunRequest(req.body, runRequestOptions);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      const admitted = await admitAgentRun(ctx, req, res, body.threadId, 'Agent run error');
      if (!admitted) return;

      const abortController = new AbortController();
      onClientDisconnect(res, () => abortController.abort());

      try {
        const result = await ctx.cogitator.run(agent, {
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          ...runRequestRunOptions(body),
          userId: req.cogitator?.auth?.userId,
          signal: abortController.signal,
          ...admitted,
        });

        res.json(toAgentRunResponse(result));
      } catch (error) {
        if (abortController.signal.aborted) return;
        handleRouteError(res, error, 'Agent run error');
      }
    }
  );

  router.post(
    '/agents/:name/resume',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const agent = findAgent(name);

      if (!agent) {
        sendError(res, 404, `Agent '${name}' not found`, 'NOT_FOUND');
        return;
      }

      const parsed = parseResumeRequest(req.body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const { threadId, decisions, defaultDecision, responses } = parsed.value;

      const admitted = await admitAgentRun(ctx, req, res, threadId, 'Agent resume error');
      if (!admitted) return;

      const abortController = new AbortController();
      onClientDisconnect(res, () => abortController.abort());

      try {
        const result = await ctx.cogitator.resume(agent, threadId, {
          userId: req.cogitator?.auth?.userId,
          decisions,
          defaultDecision,
          responses,
          signal: abortController.signal,
          ...admitted,
        });

        res.json(toAgentRunResponse(result));
      } catch (error) {
        if (abortController.signal.aborted) return;
        handleRouteError(res, error, 'Agent resume error');
      }
    }
  );

  router.post(
    '/agents/:name/stream',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const agent = findAgent(name);

      if (!agent) {
        sendError(res, 404, `Agent '${name}' not found`, 'NOT_FOUND');
        return;
      }

      if (await reconnect(req, res)) return;

      const parsed = parseRunRequest(req.body, runRequestOptions);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      const admitted = await admitAgentRun(ctx, req, res, body.threadId, 'Agent stream error');
      if (!admitted) return;

      await streamAgent(req, res, body.threadId, 'Agent stream error', (session, signal) =>
        ctx.cogitator.run(agent, {
          input: body.input,
          context: body.context,
          threadId: session.threadId,
          ...runRequestRunOptions(body),
          userId: req.cogitator?.auth?.userId,
          signal,
          stream: true,
          ...session.callbacks,
          ...admitted,
        })
      );
    }
  );

  router.post(
    '/agents/:name/resume/stream',
    async (req: CogitatorRequest<{ name: string }>, res: Response) => {
      const { name } = req.params;
      const agent = findAgent(name);

      if (!agent) {
        sendError(res, 404, `Agent '${name}' not found`, 'NOT_FOUND');
        return;
      }

      if (await reconnect(req, res)) return;

      const parsed = parseResumeRequest(req.body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const { threadId, decisions, defaultDecision, responses } = parsed.value;

      const admitted = await admitAgentRun(ctx, req, res, threadId, 'Agent resume stream error');
      if (!admitted) return;

      await streamAgent(req, res, threadId, 'Agent resume stream error', (session, signal) =>
        ctx.cogitator.resume(agent, threadId, {
          userId: req.cogitator?.auth?.userId,
          decisions,
          defaultDecision,
          responses,
          signal,
          stream: true,
          ...session.callbacks,
          ...admitted,
        })
      );
    }
  );

  return router;
}
