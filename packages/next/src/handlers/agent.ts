import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { AgentHandlerOptions, AgentInput } from '../types.js';
import {
  exceedsDeclaredSize,
  hookErrorResponse,
  isPlainObject,
  jsonError,
  jsonResponse,
  readJsonBody,
  runErrorResponse,
} from './http.js';
import { toAgentResponse } from './result.js';

type ParseResult = { ok: true; input: AgentInput } | { ok: false; error: string };

function parseDefaultInput(body: unknown): ParseResult {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  if (typeof body.input !== 'string' || body.input.trim() === '') {
    return { ok: false, error: 'input must be a non-empty string' };
  }

  if (body.context !== undefined && !isPlainObject(body.context)) {
    return { ok: false, error: 'context must be an object' };
  }

  if (body.threadId !== undefined && typeof body.threadId !== 'string') {
    return { ok: false, error: 'threadId must be a string' };
  }

  return {
    ok: true,
    input: {
      input: body.input,
      context: body.context,
      threadId: body.threadId,
    },
  };
}

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
      const parsed = parseDefaultInput(body.body);
      if (!parsed.ok) return jsonError(parsed.error, 400);
      input = parsed.input;
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
