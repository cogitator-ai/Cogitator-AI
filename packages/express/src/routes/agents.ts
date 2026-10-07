import { Router } from 'express';
import type { Response } from 'express';
import type { RouteContext, CogitatorRequest, AgentListResponse } from '../types.js';
import {
  AgentStreamSession,
  parseResumeRequest,
  parseRunRequest,
  toAgentRunResponse,
} from '@cogitator-ai/server-shared';
import { ExpressStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { handleRouteError, onClientDisconnect, resolveError, sendError } from './utils.js';

export function createAgentRoutes(ctx: RouteContext): Router {
  const router = Router();
  const runRequestOptions = { acceptContext: ctx.config.acceptContext };

  const findAgent = (name: string) =>
    Object.hasOwn(ctx.agents, name) ? ctx.agents[name] : undefined;

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

      const abortController = new AbortController();
      onClientDisconnect(res, () => abortController.abort());

      try {
        const result = await ctx.cogitator.run(agent, {
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          userId: req.cogitator?.auth?.userId,
          signal: abortController.signal,
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
      const { threadId, decisions, defaultDecision } = parsed.value;

      const abortController = new AbortController();
      onClientDisconnect(res, () => abortController.abort());

      try {
        const result = await ctx.cogitator.resume(agent, threadId, {
          userId: req.cogitator?.auth?.userId,
          decisions,
          defaultDecision,
          signal: abortController.signal,
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

      const parsed = parseRunRequest(req.body, runRequestOptions);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      setupSSEHeaders(res);
      const writer = new ExpressStreamWriter(res, { heartbeatMs: ctx.config.sseHeartbeatMs });
      const session = new AgentStreamSession((event) => writer.send(event), {
        threadId: body.threadId,
      });
      const abortController = new AbortController();

      onClientDisconnect(res, () => {
        abortController.abort();
        writer.close();
      });

      try {
        session.start();
        const result = await ctx.cogitator.run(agent, {
          input: body.input,
          context: body.context,
          threadId: session.threadId,
          userId: req.cogitator?.auth?.userId,
          signal: abortController.signal,
          stream: true,
          ...session.callbacks,
        });
        session.complete(result);
      } catch (error) {
        if (!abortController.signal.aborted) {
          const resolved = resolveError(error, 'Agent stream error');
          session.fail(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }
    }
  );

  return router;
}
