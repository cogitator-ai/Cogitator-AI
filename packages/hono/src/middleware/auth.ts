import { createMiddleware } from 'hono/factory';
import type { HonoEnv, AuthFunction } from '../types.js';

export function createAuthMiddleware(authFn: AuthFunction) {
  return createMiddleware<HonoEnv>(async (c, next): Promise<void | Response> => {
    try {
      const ctx = c.get('cogitator');
      const auth = await authFn(ctx);
      c.set('cogitatorAuth', auth);
    } catch {
      return c.json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }, 401);
    }
    await next();
  });
}
