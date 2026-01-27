import type { ErrorHandler } from 'hono';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';
import type { HonoEnv } from '../types.js';

export const errorHandler: ErrorHandler<HonoEnv> = (err, c) => {
  if (CogitatorError.isCogitatorError(err)) {
    const statusCode = ERROR_STATUS_CODES[err.code] || 500;
    return c.json(
      { error: { message: err.message, code: err.code } },
      statusCode as Parameters<typeof c.json>[1]
    );
  }

  console.error('[CogitatorHono] Unhandled error:', err);

  return c.json(
    { error: { message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR } },
    500
  );
};
