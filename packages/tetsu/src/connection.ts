import { hook, httpError } from '@tetsujs/core';
import { refuseNonJsonBody } from '@cogitator-ai/server-shared';

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

/**
 * The `beforeParse` hook of every route with a JSON body: a body that is not JSON is refused
 * with `415 UNSUPPORTED_MEDIA_TYPE` before it is read.
 *
 * Tetsu parses a body as the route declares it, whatever the `content-type` says. Browsers
 * send `text/plain` and form bodies across origins without a CORS preflight, so without this
 * hook any web page could start a run on a server without auth, or with cookies.
 */
export const jsonBody = hook.beforeParse((ctx) => {
  const refusal = refuseNonJsonBody(ctx.req.method, ctx.req.headers);
  if (refusal) throw httpError(refusal.status, refusal.code, refusal.message);
});
