import { createMiddleware } from 'hono/factory';
import type { HonoEnv, AuthFunction } from '../types.js';

export function createAuthMiddleware(authFn: AuthFunction) {
  return createMiddleware<HonoEnv>(async (c, next): Promise<void | Response> => {
    try {
      const auth = await authFn(c);
      c.set('cogitatorAuth', auth);
    } catch {
      return c.json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
    }
    await next();
  });
}
