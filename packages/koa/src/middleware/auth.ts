import type { Context, Next } from 'koa';
import type { AuthFunction, CogitatorState } from '../types.js';

export function createAuthMiddleware(authFn: AuthFunction) {
  return async (ctx: Context, next: Next) => {
    try {
      const auth = await authFn(ctx);
      (ctx.state as CogitatorState).auth = auth;
      await next();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status && status >= 500) {
        throw err;
      }
      ctx.status = 401;
      ctx.body = {
        error: {
          message: err instanceof Error ? err.message : 'Unauthorized',
          code: 'UNAUTHORIZED',
        },
      };
    }
  };
}
