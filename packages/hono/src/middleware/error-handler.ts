import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type { HonoEnv } from '../types.js';
import { cogitatorErrorStatus } from '../utils/errors.js';

export const errorHandler: ErrorHandler<HonoEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  if (CogitatorError.isCogitatorError(err)) {
    return c.json({ error: { message: err.message, code: err.code } }, cogitatorErrorStatus(err));
  }

  console.error('[CogitatorHono] Unhandled error:', err);

  return c.json(
    { error: { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR } },
    500
  );
};
