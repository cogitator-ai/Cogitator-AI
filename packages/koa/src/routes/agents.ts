import Router from '@koa/router';
import type {
  CogitatorState,
  AgentListResponse,
  AgentRunRequest,
  AgentRunResponse,
} from '../types.js';
import { KoaStreamWriter, setupSSEHeaders } from '../streaming/index.js';
import { generateId } from '@cogitator-ai/server-shared';
import type { ToolCall } from '@cogitator-ai/types';

export function createAgentRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/agents', (ctx) => {
    const { agents } = ctx.state.cogitator;
    const agentList = Object.entries(agents).map(([name, agent]) => ({
      name,
      description: agent.config.instructions?.slice(0, 100),
      tools: agent.config.tools?.map((t) => t.name) || [],
    }));

    const response: AgentListResponse = { agents: agentList };
    ctx.body = response;
  });

  router.post('/agents/:name/run', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = agents[name];

    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const body = (ctx.request as unknown as { body: AgentRunRequest }).body;
    if (!body?.input) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } };
      return;
    }

    try {
      const result = await runtime.run(agent, {
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

      ctx.body = response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      ctx.status = 500;
      ctx.body = { error: { message, code: 'INTERNAL' } };
    }
  });

  router.post('/agents/:name/stream', async (ctx) => {
    const { agents, runtime } = ctx.state.cogitator;
    const { name } = ctx.params;
    const agent = agents[name];

    if (!agent) {
      ctx.status = 404;
      ctx.body = { error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } };
      return;
    }

    const body = (ctx.request as unknown as { body: AgentRunRequest }).body;
    if (!body?.input) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } };
      return;
    }

    setupSSEHeaders(ctx);
    const writer = new KoaStreamWriter(ctx);
    const messageId = generateId('msg');

    ctx.req.on('close', () => {
      writer.close();
    });

    let textStarted = false;
    let textId = '';

    try {
      writer.start(messageId);
      textId = generateId('txt');
      textStarted = true;
      writer.textStart(textId);

      const result = await runtime.run(agent, {
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
      if (textStarted) {
        writer.textEnd(textId);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      writer.error(message, 'INTERNAL');
    } finally {
      writer.close();
    }
  });

  return router;
}
