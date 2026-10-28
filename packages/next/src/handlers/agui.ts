import type { Cogitator, Agent } from '@cogitator-ai/core';
import { parseAGUIRunInput, streamAGUIRun } from '@cogitator-ai/server-shared/agui';
import { StreamWriter } from '../streaming/stream-writer.js';
import type { AGUIHandlerOptions } from '../types.js';
import {
  depsOf,
  describeRunError,
  exceedsDeclaredSize,
  hookErrorResponse,
  jsonError,
  readJsonBody,
  refuseRequest,
  runErrorResponse,
} from './http.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * A route handler that speaks AG-UI 1.0: it takes a `RunAgentInput` and streams the run as AG-UI
 * events over SSE, so a CopilotKit or `@ag-ui/client` `HttpAgent` frontend runs the agent. The
 * AG-UI thread is the run's thread, kept in the Cogitator's memory: a request runs its last
 * message, which must be the user's, or resumes the paused run with its `resume` entries, all
 * of the interrupts at once. The request's `state` is the run's state, `context` its brief.
 * Return `{ userId }` from `beforeRun` to run as the signed-in user.
 *
 * @example
 * ```ts
 * // app/api/agui/route.ts
 * export const POST = createAGUIHandler(cogitator, agent, {
 *   beforeRun: async (req) => ({ userId: await userIdFrom(req) }),
 * });
 * ```
 */
export function createAGUIHandler(
  cogitator: Cogitator,
  agent: Agent,
  options?: AGUIHandlerOptions
) {
  return async (req: Request): Promise<Response> => {
    if (exceedsDeclaredSize(req)) {
      return jsonError('Payload too large', 413, 'PAYLOAD_TOO_LARGE');
    }
    const body = await readJsonBody(req);
    if (!body.ok) return body.response;
    const parsed = parseAGUIRunInput(body.body);
    if (!parsed.ok) return jsonError(parsed.message, 400, 'INVALID_INPUT');
    const threadId = parsed.value.input.threadId;

    let runContext: Record<string, unknown> = {};
    if (options?.beforeRun) {
      try {
        const ctx = await options.beforeRun(req, parsed.value.input);
        if (ctx) runContext = ctx;
      } catch (err) {
        return hookErrorResponse(err, 'Unauthorized');
      }
    }
    try {
      const refused = await refuseRequest(req, threadId, runContext, options);
      if (refused) return refused;
      runContext = { ...(await depsOf(req, options)), ...runContext };
    } catch (err) {
      return runErrorResponse(err);
    }
    const userId = typeof runContext.userId === 'string' ? runContext.userId : undefined;

    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = new StreamWriter(writable.getWriter(), { heartbeatMs: options?.sseHeartbeatMs });
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (req.signal.aborted) abort();
    else req.signal.addEventListener('abort', abort, { once: true });

    let queue: Promise<void> = Promise.resolve();
    const run = async () => {
      try {
        await streamAGUIRun({
          request: parsed.value,
          send: (event) => {
            queue = queue.then(() => writer.sendData(event)).catch(abort);
          },
          signal: abortController.signal,
          describeError: describeRunError,
          host: {
            run: async (runOptions) => {
              const result = await cogitator.run(agent, { ...runOptions, ...runContext });
              if (options?.afterRun) await options.afterRun(result);
              return result;
            },
            resume: async (resumeOptions) => {
              const result = await cogitator.resume(agent, threadId, {
                ...resumeOptions,
                ...runContext,
              });
              if (options?.afterRun) await options.afterRun(result);
              return result;
            },
            pausedRun: () => cogitator.pausedRun(threadId),
            cancelPause: (reason) =>
              cogitator.cancelPause(threadId, {
                ...(userId !== undefined && { userId }),
                reason,
              }),
          },
        });
        await queue;
      } finally {
        req.signal.removeEventListener('abort', abort);
        await writer.close();
      }
    };
    void run().catch(() => {});

    return new Response(readable, { headers: SSE_HEADERS });
  };
}
