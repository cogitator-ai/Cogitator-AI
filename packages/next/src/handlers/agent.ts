import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { AgentHandlerOptions, AgentInput, AgentResponse } from '../types.js';

function parseDefaultInput(body: unknown): AgentInput {
  const data = body as { input?: string; context?: Record<string, unknown>; threadId?: string };

  return {
    input: typeof data.input === 'string' ? data.input : '',
    context: data.context,
    threadId: typeof data.threadId === 'string' ? data.threadId : undefined,
  };
}

export function createAgentHandler(
  cogitator: Cogitator,
  agent: Agent,
  options?: AgentHandlerOptions
) {
  return async (req: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let input: AgentInput;
    try {
      input = options?.parseInput ? await options.parseInput(req) : parseDefaultInput(body);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : 'Parse error' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let runContext: Record<string, unknown> = {};
    if (options?.beforeRun) {
      try {
        const ctx = await options.beforeRun(req, input);
        if (ctx) runContext = ctx;
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : 'Unauthorized' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    try {
      const result = await cogitator.run(agent, {
        input: input.input,
        threadId: input.threadId,
        context: input.context,
        ...runContext,
      });

      if (options?.afterRun) {
        await options.afterRun(result);
      }

      const response: AgentResponse = {
        output: result.output,
        threadId: result.threadId,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
        },
        toolCalls: [...result.toolCalls],
        trace: {
          traceId: result.trace.traceId,
          spans: [...result.trace.spans],
        },
      };

      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}
