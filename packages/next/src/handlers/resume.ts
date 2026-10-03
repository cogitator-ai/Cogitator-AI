import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { ToolApprovalDecision } from '@cogitator-ai/types';
import type { ResumeDecisions, ResumeHandlerOptions, ResumeInput } from '../types.js';
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
import { streamAgentRun } from './stream-run.js';

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseDecision(value: unknown, field: string): Parsed<ToolApprovalDecision> {
  if (!isPlainObject(value) || typeof value.approved !== 'boolean') {
    return { ok: false, error: `${field} must be an object with a boolean approved` };
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return { ok: false, error: `${field}.reason must be a string` };
  }
  if (value.approved) return { ok: true, value: { approved: true } };
  return {
    ok: true,
    value:
      value.reason === undefined ? { approved: false } : { approved: false, reason: value.reason },
  };
}

function parseDefaultInput(body: unknown): Parsed<ResumeInput> {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }

  if (typeof body.threadId !== 'string' || body.threadId === '') {
    return { ok: false, error: 'threadId must be a non-empty string' };
  }

  const input: ResumeInput = { threadId: body.threadId };

  if (body.decisions !== undefined) {
    if (!isPlainObject(body.decisions)) {
      return { ok: false, error: 'decisions must be an object keyed by tool call id' };
    }
    const decisions: Record<string, ToolApprovalDecision> = {};
    for (const [toolCallId, value] of Object.entries(body.decisions)) {
      const decision = parseDecision(value, `decisions.${toolCallId}`);
      if (!decision.ok) return decision;
      decisions[toolCallId] = decision.value;
    }
    input.decisions = decisions;
  }

  if (body.defaultDecision !== undefined) {
    const decision = parseDecision(body.defaultDecision, 'defaultDecision');
    if (!decision.ok) return decision;
    input.defaultDecision = decision.value;
  }

  return { ok: true, value: input };
}

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
      const parsed = parseDefaultInput(body.body);
      if (!parsed.ok) return jsonError(parsed.error, 400);
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
        start: (callbacks) =>
          cogitator.resume(agent, input.threadId, { ...decisions, ...runContext, ...callbacks }),
        afterRun: options.afterRun,
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
