import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { generateId } from '@cogitator-ai/server-shared';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';
import type { HonoEnv, AgentListResponse, AgentRunRequest, AgentRunResponse } from '../types.js';
import type { ToolCall } from '@cogitator-ai/types';

export function createAgentRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/agents', (c) => {
    const ctx = c.get('cogitator');
    const agentList = Object.entries(ctx.agents).map(([name, agent]) => ({
      name,
      description: agent.config.instructions?.slice(0, 100),
      tools: agent.config.tools?.map((t) => t.name) || [],
    }));

    const response: AgentListResponse = { agents: agentList };
    return c.json(response);
  });

  app.post('/agents/:name/run', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = ctx.agents[name];

    if (!agent) {
      return c.json({ error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    let body: AgentRunRequest;
    try {
      body = await c.req.json<AgentRunRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    if (!body?.input) {
      return c.json(
        { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } },
        400
      );
    }

    try {
      const result = await ctx.runtime.run(agent, {
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

      return c.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: { message, code: 'INTERNAL' } }, 500);
    }
  });

  app.post('/agents/:name/stream', async (c) => {
    const ctx = c.get('cogitator');
    const name = c.req.param('name');
    const agent = ctx.agents[name];

    if (!agent) {
      return c.json({ error: { message: `Agent '${name}' not found`, code: 'NOT_FOUND' } }, 404);
    }

    let body: AgentRunRequest;
    try {
      body = await c.req.json<AgentRunRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    if (!body?.input) {
      return c.json(
        { error: { message: 'Missing required field: input', code: 'INVALID_INPUT' } },
        400
      );
    }

    return streamSSE(c, async (stream) => {
      const writer = new HonoStreamWriter(stream);
      const messageId = generateId('msg');

      stream.onAbort(() => writer.close());

      let textStarted = false;
      let textId = '';

      try {
        await writer.start(messageId);
        textId = generateId('txt');
        textStarted = true;
        await writer.textStart(textId);

        const result = await ctx.runtime.run(agent, {
          input: body.input,
          context: body.context,
          threadId: body.threadId,
          stream: true,
          onToken: (token: string) => {
            void writer.textDelta(textId, token);
          },
          onToolCall: (toolCall: ToolCall) => {
            const toolId = generateId('tool');
            void writer.toolCallStart(toolId, toolCall.name);
            void writer.toolCallEnd(toolId);
          },
          onToolResult: (toolResult: { callId: string; result: unknown }) => {
            const resultId = generateId('res');
            void writer.toolResult(resultId, toolResult.callId, toolResult.result);
          },
        });

        await writer.textEnd(textId);
        await writer.finish(messageId, {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        });
      } catch (error) {
        if (textStarted) {
          await writer.textEnd(textId);
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        await writer.error(message, 'INTERNAL');
      } finally {
        writer.close();
      }
    });
  });

  return app;
}
