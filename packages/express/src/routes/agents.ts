import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  AgentListResponse,
  AgentRunRequest,
  AgentRunResponse,
} from '../types.js';
import { ExpressStreamWriter, setupSSEHeaders, generateId } from '../streaming/index.js';
import { CogitatorError, type ToolCall } from '@cogitator-ai/types';

export function createAgentRoutes(ctx: RouteContext): Router {
  const router = Router();

  router.get('/agents', (_req, res) => {
    const agentList = Object.entries(ctx.agents).map(([name, agent]) => ({
      name,
      description: agent.config.instructions?.slice(0, 100),
      tools: agent.config.tools?.map((t) => t.name) || [],
    }));

    const response: AgentListResponse = { agents: agentList };
    res.json(response);
  });

  router.post('/agents/:name/run', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const agent = Object.hasOwn(ctx.agents, name) ? ctx.agents[name] : undefined;

    if (!agent) {
      res.status(404).json({
        error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    const body = req.body as AgentRunRequest;
    if (!body?.input) {
      res.status(400).json({
        error: { message: 'Missing required field: input', code: 'INVALID_INPUT' },
      });
      return;
    }

    try {
      const result = await ctx.cogitator.run(agent, {
        input: body.input,
        context: body.context,
        threadId: body.threadId,
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
      if (CogitatorError.isCogitatorError(error)) {
        res.status(500).json({ error: { message: error.message, code: error.code } });
      } else {
        console.error('[CogitatorServer] Agent run error:', error);
        res.status(500).json({ error: { message: 'Internal server error', code: 'INTERNAL' } });
      }
    }
  });

  router.post('/agents/:name/stream', async (req: CogitatorRequest, res: Response) => {
    const { name } = req.params;
    const agent = Object.hasOwn(ctx.agents, name) ? ctx.agents[name] : undefined;

    if (!agent) {
      res.status(404).json({
        error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' },
      });
      return;
    }

    const body = req.body as AgentRunRequest;
    if (!body?.input) {
      res.status(400).json({
        error: { message: 'Missing required field: input', code: 'INVALID_INPUT' },
      });
      return;
    }

    setupSSEHeaders(res);
    const writer = new ExpressStreamWriter(res);
    const messageId = generateId('msg');

    req.on('close', () => {
      writer.close();
    });

    try {
      writer.start(messageId);
      const textId = generateId('txt');
      writer.textStart(textId);

      const result = await ctx.cogitator.run(agent, {
        input: body.input,
        context: body.context,
        threadId: body.threadId,
        stream: true,
        onToken: (token: string) => {
          writer.textDelta(textId, token);
        },
        onToolCall: (toolCall: ToolCall) => {
          const toolId = generateId('tool');
          writer.toolCallStart(toolId, toolCall.name);
          writer.toolCallEnd(toolId);
        },
        onToolResult: (toolResult: { callId: string; result: unknown }) => {
          const resultId = generateId('res');
          writer.toolResult(resultId, toolResult.callId, toolResult.result);
        },
      });

      writer.textEnd(textId);
      writer.finish(messageId, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens,
      });
    } catch (error) {
      if (CogitatorError.isCogitatorError(error)) {
        writer.error(error.message, error.code);
      } else {
        console.error('[CogitatorServer] Agent stream error:', error);
        writer.error('Internal server error', 'INTERNAL');
      }
    } finally {
      writer.close();
    }
  });

  return router;
}
