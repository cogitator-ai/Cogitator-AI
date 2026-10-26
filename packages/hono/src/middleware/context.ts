import { createMiddleware } from 'hono/factory';
import {
  DEFAULT_THREAD_MESSAGE_ROLES,
  ResumableStreams,
  checkRunLimits,
  generateId,
  resolveSseHeartbeatMs,
} from '@cogitator-ai/server-shared';
import type { HonoEnv, CogitatorAppOptions } from '../types.js';

/**
 * Sets the Cogitator context of each request.
 *
 * @throws Error when `opts.limits` holds a limit that is not a positive integer, RangeError
 * for a `resumableStreams` limit that is not a positive whole number
 */
export function createContextMiddleware(opts: CogitatorAppOptions) {
  const sseHeartbeatMs = resolveSseHeartbeatMs(opts.sseHeartbeatMs);
  const limits = checkRunLimits(opts.limits);
  const resumableStreams = ResumableStreams.from(opts.resumableStreams);
  return createMiddleware<HonoEnv>(async (c, next) => {
    c.set('cogitator', {
      runtime: opts.cogitator,
      agents: opts.agents ?? {},
      workflows: opts.workflows ?? {},
      swarms: opts.swarms ?? {},
      sseHeartbeatMs,
      acceptContext: opts.acceptContext ?? false,
      threadMessageRoles: opts.threadMessageRoles ?? DEFAULT_THREAD_MESSAGE_ROLES,
      limits,
      authorizeThread: opts.authorizeThread,
      deps: opts.deps,
      workflowCheckpoints: opts.workflowCheckpoints,
      resumableStreams,
    });
    c.set('cogitatorRequestId', generateId('req'));
    c.set('cogitatorStartTime', Date.now());

    await next();
  });
}
