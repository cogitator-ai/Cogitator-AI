import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { PAYLOAD_TOO_LARGE } from '@cogitator-ai/server-shared';
import type { HonoEnv } from '../types.js';
import { sendError } from '../utils/request.js';

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function createBodyLimitMiddleware(
  maxSize: number = DEFAULT_BODY_LIMIT
): MiddlewareHandler<HonoEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) => sendError(c, PAYLOAD_TOO_LARGE),
  });
}
