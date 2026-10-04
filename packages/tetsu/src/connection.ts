import { hook } from '@tetsujs/core';

/**
 * The `beforeHandle` hook of the routes that answer a run with JSON: lifts the idle
 * timeout of `Bun.serve` for this one request.
 *
 * Bun closes a connection that stays silent for `idleTimeout` seconds, 10 by default.
 * A JSON answer has nothing to send until the run ends, so a run that waits longer on
 * the model or a tool would be cut off. It runs after the body is read and validated,
 * so a slow upload is still bound by the timeout. The streaming routes need no such
 * hook: their heartbeats keep the connection busy.
 */
export const holdConnection = hook.beforeHandle((ctx) => {
  ctx.server.timeout(ctx.req, 0);
});
