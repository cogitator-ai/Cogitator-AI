import { Router } from 'express';
import type { Response } from 'express';
import type { RouteContext, CogitatorRequest, AgentListResponse } from '../types.js';
import { parseRunRequest } from '@cogitator-ai/server-shared';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import {
  handleRouteError,
  onClientDisconnect,
  parseResumeBody,
  resolveError,
  sendError,
  toAgentRunResponse,
} from './utils.js';

export function createAgentRoutes(ctx: RouteContext): Router {
  const router = Router();

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

      const parsed = parseRunRequest(req.body);
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

      const parsed = parseResumeBody(req.body);
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

      const parsed = parseRunRequest(req.body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      setupSSEHeaders(res);
      const writer = new ExpressStreamWriter(res, { heartbeatMs: ctx.config.sseHeartbeatMs });
      const messageId = generateId('msg');
      const abortController = new AbortController();

      onClientDisconnect(res, () => {
        abortController.abort();
        writer.close();
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

      try {
        writer.start(messageId);

        const result = await ctx.cogitator.run(agent, {
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          userId: req.cogitator?.auth?.userId,
          signal: abortController.signal,
          stream: true,
          onToken: (token) => {
            if (token) streamedText = true;
            writeText(token);
          },
          onReasoning: writeReasoning,
          onToolCall: (toolCall) => {
            endParts();
            writer.toolCallStart(toolCall.id, toolCall.name);
            writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
            writer.toolCallEnd(toolCall.id);
          },
          onToolResult: (toolResult) => {
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
          const resolved = resolveError(error, 'Agent stream error');
          endParts();
          writer.error(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }
    }
  );

  return router;
}
