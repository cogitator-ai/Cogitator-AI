import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  AgentListResponse,
  AgentRunResponse,
} from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import {
  handleRouteError,
  onClientDisconnect,
  parseRunBody,
  resolveError,
  sendError,
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

      const parsed = parseRunBody(req.body);
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

        res.json(response);
      } catch (error) {
        if (abortController.signal.aborted) return;
        handleRouteError(res, error, 'Agent run error');
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

      const parsed = parseRunBody(req.body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      setupSSEHeaders(res);
      const writer = new ExpressStreamWriter(res);
      const messageId = generateId('msg');
      const abortController = new AbortController();

      onClientDisconnect(res, () => {
        abortController.abort();
        writer.close();
      });

      let textId: string | null = null;
      let streamedText = false;

      const writeText = (delta: string) => {
        if (!delta) return;
        if (textId === null) {
          textId = generateId('txt');
          writer.textStart(textId);
        }
        writer.textDelta(textId, delta);
      };

      const endText = () => {
        if (textId === null) return;
        writer.textEnd(textId);
        textId = null;
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
          onToolCall: (toolCall) => {
            endText();
            writer.toolCallStart(toolCall.id, toolCall.name);
            writer.toolCallDelta(toolCall.id, JSON.stringify(toolCall.arguments));
            writer.toolCallEnd(toolCall.id);
          },
          onToolResult: (toolResult) => {
            writer.toolResult(generateId('res'), toolResult.callId, toolResult.result);
          },
        });

        if (!streamedText) writeText(result.output);
        endText();
        writer.finish(messageId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });
      } catch (error) {
        if (!abortController.signal.aborted) {
          const resolved = resolveError(error, 'Agent stream error');
          endText();
          writer.error(resolved.message, resolved.code);
        }
      } finally {
        writer.close();
      }
    }
  );

  return router;
}
