import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HonoEnv } from '../types.js';
import { describeError } from '../utils/errors.js';
import { sendError } from '../utils/request.js';

export const errorHandler: ErrorHandler<HonoEnv> = (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return sendError(c, describeError(err, 'Unhandled error'));
};
