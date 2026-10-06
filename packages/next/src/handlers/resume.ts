import type { Cogitator, Agent } from '@cogitator-ai/core';
import { parseResumeRequest } from '@cogitator-ai/server-shared';
import type { ResumeDecisions, ResumeHandlerOptions, ResumeInput } from '../types.js';
import {
  exceedsDeclaredSize,
  hookErrorResponse,
  jsonError,
  jsonResponse,
  readJsonBody,
  runErrorResponse,
} from './http.js';
import { toAgentResponse } from './result.js';
import { streamAgentRun } from './stream-run.js';

function decisionsOf(input: ResumeInput): ResumeDecisions {
  return {
    ...(input.decisions !== undefined && { decisions: input.decisions }),
    ...(input.defaultDecision !== undefined && { defaultDecision: input.defaultDecision }),
  };
}

/**
 * A route handler that continues a run paused for tool approvals, by thread id.
 *
 * Approved calls run, declined ones answer the model with the reason, and calls
 * without a decision pause the run again. Only the user the run belongs to may
 * resume it: return `{ userId }` from `beforeRun`, as for the other handlers.
 * Answers like `createAgentHandler`, or streams like `createChatHandler` with
 * `stream: true`. A thread without a paused run answers `409 RUN_NOT_PAUSED`,
 * another user's run `403 THREAD_ACCESS_DENIED`.
 *
 * @example
 * ```ts
 * // app/api/chat/resume/route.ts
 * export const POST = createResumeHandler(cogitator, agent, {
 *   stream: true,
 *   beforeRun: async (req) => ({ userId: await userIdFrom(req) }),
 * });
 * ```
 */
export function createResumeHandler(
  cogitator: Cogitator,
  agent: Agent,
  options?: ResumeHandlerOptions
) {
  return async (req: Request): Promise<Response> => {
    if (exceedsDeclaredSize(req)) {
      return jsonError('Payload too large', 413);
    }

    let input: ResumeInput;
    if (options?.parseInput) {
      try {
        input = await options.parseInput(req);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : 'Parse error', 400);
      }
    } else {
      const body = await readJsonBody(req);
      if (!body.ok) return body.response;
      const parsed = parseResumeRequest(body.body);
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

    const decisions = decisionsOf(input);

    if (options?.stream) {
      return streamAgentRun({
        req,
        runContext,
        threadId: input.threadId,
        start: (callbacks) =>
          cogitator.resume(agent, input.threadId, { ...decisions, ...runContext, ...callbacks }),
        afterRun: options.afterRun,
        heartbeatMs: options.sseHeartbeatMs,
      });
    }

    try {
      const result = await cogitator.resume(agent, input.threadId, {
        ...decisions,
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
