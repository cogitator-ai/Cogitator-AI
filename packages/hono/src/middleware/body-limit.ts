import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types.js';

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

export function createBodyLimitMiddleware(
  maxSize: number = DEFAULT_BODY_LIMIT
): MiddlewareHandler<HonoEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json({ error: { message: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' } }, 413),
  });
}
