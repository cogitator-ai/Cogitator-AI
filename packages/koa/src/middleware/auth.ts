import type { Context, Next } from 'koa';
import { UNAUTHORIZED, admitCaller, type AnonymousPolicy } from '@cogitator-ai/server-shared';
import type { AuthContext, AuthFunction, CogitatorState } from '../types.js';
import { sendError } from '../utils/errors.js';

export function createAuthMiddleware(authFn: AuthFunction) {
  return async (ctx: Context, next: Next) => {
    let auth: AuthContext | undefined;
    try {
      auth = await authFn(ctx);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status !== undefined && status >= 500) {
        throw err;
      }
      sendError(ctx, { ...UNAUTHORIZED, message: 'Unauthorized' });
      return;
    }

    (ctx.state as CogitatorState).auth = auth;
    await next();
  };
}

/**
 * Turns away callers without a `userId` when `anonymous` is `'deny'`, with
 * `401 UNAUTHORIZED`. Routes registered before it, such as health and docs, stay open.
 */
export function createAnonymousMiddleware(anonymous: AnonymousPolicy | undefined) {
  return async (ctx: Context, next: Next) => {
    const refusal = admitCaller((ctx.state as CogitatorState).auth?.userId, anonymous);
    if (refusal) {
      sendError(ctx, refusal);
      return;
    }
    await next();
  };
}
