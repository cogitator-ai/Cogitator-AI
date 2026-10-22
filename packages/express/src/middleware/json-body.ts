import type { RequestHandler } from 'express';
import { refuseNonJsonBody } from '@cogitator-ai/server-shared';
import { sendFailure } from '../routes/utils.js';

/**
 * Refuses a request whose body is not JSON with `415 UNSUPPORTED_MEDIA_TYPE` before any
 * route reads it. Browsers send `text/plain` and form bodies across origins without a
 * preflight, so the API only takes the JSON a cross-origin page cannot send unasked.
 */
export function createJsonBodyGuard(): RequestHandler {
  return (req, res, next) => {
    const refusal = refuseNonJsonBody(req.method, req.headers);
    if (!refusal) {
      next();
      return;
    }
    sendFailure(res, refusal);
  };
}
