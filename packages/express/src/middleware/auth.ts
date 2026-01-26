import type { Response, NextFunction } from 'express';
import type { CogitatorRequest, AuthFunction } from '../types.js';
import { generateId } from '../streaming/helpers.js';

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
    } catch (error) {
      res.status(401).json({
        error: {
          message: 'Unauthorized',
          code: 'UNAUTHORIZED',
        },
      });
    }
  };
}
