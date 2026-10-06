import { createMiddleware } from 'hono/factory';
import {
  DEFAULT_THREAD_MESSAGE_ROLES,
  generateId,
  resolveSseHeartbeatMs,
} from '@cogitator-ai/server-shared';
import type { HonoEnv, CogitatorAppOptions } from '../types.js';

export function createContextMiddleware(opts: CogitatorAppOptions) {
  const sseHeartbeatMs = resolveSseHeartbeatMs(opts.sseHeartbeatMs);
  return createMiddleware<HonoEnv>(async (c, next) => {
    c.set('cogitator', {
      runtime: opts.cogitator,
      agents: opts.agents ?? {},
      workflows: opts.workflows ?? {},
      swarms: opts.swarms ?? {},
      sseHeartbeatMs,
      acceptContext: opts.acceptContext ?? false,
      threadMessageRoles: opts.threadMessageRoles ?? DEFAULT_THREAD_MESSAGE_ROLES,
    });
    c.set('cogitatorRequestId', generateId('req'));
    c.set('cogitatorStartTime', Date.now());

    await next();
  });
}
