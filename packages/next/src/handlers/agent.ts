import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { AgentHandlerOptions, AgentInput } from '../types.js';
import { parseRunRequest } from '@cogitator-ai/server-shared';
import {
  exceedsDeclaredSize,
  hookErrorResponse,
  jsonError,
  jsonResponse,
  readJsonBody,
  runErrorResponse,
} from './http.js';
import { toAgentResponse } from './result.js';

export function createAgentHandler(
  cogitator: Cogitator,
  agent: Agent,
  options?: AgentHandlerOptions
) {
  return async (req: Request): Promise<Response> => {
    if (exceedsDeclaredSize(req)) {
      return jsonError('Payload too large', 413);
    }

    let input: AgentInput;
    if (options?.parseInput) {
      try {
        input = await options.parseInput(req);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'Parse error', 400);
      }
    } else {
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      const parsed = parseRunRequest(body.body, { acceptContext: options?.acceptContext });
      if (!parsed.ok) return jsonError(parsed.message, 400, 'INVALID_INPUT');
      input = parsed.value;
    }

    let runContext: Record<string, unknown> = {};
    if (options?.beforeRun) {
      try {
        const ctx = await options.beforeRun(req, input);
        if (ctx) runContext = ctx;
      } catch (err) {
        return hookErrorResponse(err, 'Unauthorized');
      }
    }

    try {
      const result = await cogitator.run(agent, {
        input: input.input,
        threadId: input.threadId,
        context: input.context,
        signal: req.signal,
        ...runContext,
      });

      if (options?.afterRun) {
        await options.afterRun(result);
      }

      return jsonResponse(toAgentResponse(result));
    } catch (err) {
      return runErrorResponse(err);
    }
  };
}
