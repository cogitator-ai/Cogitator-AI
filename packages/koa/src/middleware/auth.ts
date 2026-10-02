import type { Context, Next } from 'koa';
import type { AuthContext, AuthFunction, CogitatorState } from '../types.js';

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
      ctx.status = 401;
      ctx.body = { error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } };
      return;
    }

    (ctx.state as CogitatorState).auth = auth;
    await next();
  };
}
