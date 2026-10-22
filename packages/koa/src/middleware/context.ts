import type { Context, Next } from 'koa';
import type { CogitatorAppOptions, CogitatorState, RouteContext } from '../types.js';
import {
  DEFAULT_THREAD_MESSAGE_ROLES,
  checkRunLimits,
  generateId,
  resolveSseHeartbeatMs,
} from '@cogitator-ai/server-shared';

/**
 * Sets the Cogitator state of each request.
 *
 * @throws Error when `opts.limits` holds a limit that is not a positive integer
 */
export function createContextMiddleware(opts: CogitatorAppOptions) {
  const routeCtx: RouteContext = {
    runtime: opts.cogitator,
    agents: opts.agents ?? {},
    workflows: opts.workflows ?? {},
    swarms: opts.swarms ?? {},
    sseHeartbeatMs: resolveSseHeartbeatMs(opts.sseHeartbeatMs),
    acceptContext: opts.acceptContext ?? false,
    threadMessageRoles: opts.threadMessageRoles ?? DEFAULT_THREAD_MESSAGE_ROLES,
    limits: checkRunLimits(opts.limits),
    authorizeThread: opts.authorizeThread,
    anonymous: opts.anonymous,
    deps: opts.deps,
  };

  return async (ctx: Context, next: Next) => {
    const state = ctx.state as CogitatorState;
    state.cogitator = routeCtx;
    state.requestId = generateId('req');
    state.startTime = Date.now();
    await next();
  };
}
