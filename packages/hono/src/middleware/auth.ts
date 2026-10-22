import { createMiddleware } from 'hono/factory';
import { UNAUTHORIZED, admitCaller, type AnonymousPolicy } from '@cogitator-ai/server-shared';
import type { HonoEnv, AuthFunction } from '../types.js';
import { sendError } from '../utils/request.js';

export function createAuthMiddleware(authFn: AuthFunction) {
  return createMiddleware<HonoEnv>(async (c, next): Promise<void | Response> => {
    try {
      const auth = await authFn(c);
      c.set('cogitatorAuth', auth);
    } catch {
      return sendError(c, { ...UNAUTHORIZED, message: 'Unauthorized' });
    }
    await next();
  });
}

/**
 * Turns away callers without a `userId` when `anonymous` is `'deny'`, with
 * `401 UNAUTHORIZED`. Routes registered before it, such as health and docs, stay open.
 */
export function createAnonymousMiddleware(anonymous: AnonymousPolicy | undefined) {
  return createMiddleware<HonoEnv>(async (c, next): Promise<void | Response> => {
    const refusal = admitCaller(c.get('cogitatorAuth')?.userId, anonymous);
    if (refusal) return sendError(c, refusal);
    await next();
  });
}
