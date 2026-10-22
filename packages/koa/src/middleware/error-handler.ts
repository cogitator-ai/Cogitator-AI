import type { Context, Next } from 'koa';
import { INTERNAL_ERROR, describeHttpError } from '@cogitator-ai/server-shared';
import { sendError } from '../utils/errors.js';

export function createErrorHandler() {
  return async (ctx: Context, next: Next) => {
    try {
      await next();
    } catch (err) {
      if (ctx.headerSent) return;

      const described = describeHttpError(err);
      if (described) {
        sendError(ctx, described);
        return;
      }

      const status = (err as { status?: number } | null)?.status;
      if (status && status >= 400 && status < 500) {
        sendError(ctx, {
          status,
          code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'HTTP_ERROR',
          message: err instanceof Error ? err.message : 'HTTP error',
        });
        return;
      }

      console.error('[CogitatorKoa] Unhandled error:', err);
      sendError(ctx, {
        ...INTERNAL_ERROR,
        ...(status && status >= 500 && status < 600 && { status }),
      });
    }
  };
}
