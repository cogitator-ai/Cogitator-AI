import type { Response, NextFunction } from 'express';
import { admitCaller, type AnonymousPolicy } from '@cogitator-ai/server-shared';
import type { CogitatorRequest, AuthFunction } from '../types.js';
import { generateId } from '../streaming/helpers.js';
import { sendError, sendFailure } from '../routes/utils.js';

export function createAuthMiddleware(authFn?: AuthFunction) {
  return async (req: CogitatorRequest, res: Response, next: NextFunction) => {
    req.cogitator = {
      requestId: generateId('req'),
      startTime: Date.now(),
    };

    if (!authFn) {
      return next();
    }

    try {
      const auth = await authFn(req);
      req.cogitator.auth = auth;
      next();
    } catch {
      sendError(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    }
  };
}

/**
 * Answers `401 UNAUTHORIZED` to a caller without a user id when `anonymous` is `'deny'`.
 * Mounted after the public routes (health, ready, docs), so only the API is closed.
 */
export function createAnonymousGuard(anonymous: AnonymousPolicy | undefined) {
  return (req: CogitatorRequest, res: Response, next: NextFunction) => {
    const refusal = admitCaller(req.cogitator?.auth?.userId, anonymous);
    if (!refusal) {
      next();
      return;
    }
    sendFailure(res, refusal);
  };
}
