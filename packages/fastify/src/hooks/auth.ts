import type { FastifyRequest, FastifyReply, onRequestHookHandler } from 'fastify';
import { admitCaller, type AnonymousPolicy } from '@cogitator-ai/server-shared';
import type { AuthFunction } from '../types.js';
import { generateId } from '../streaming/helpers.js';
import { sendError, sendFailure } from '../routes/utils.js';

export function createAuthHook(authFn?: AuthFunction): onRequestHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    request.cogitatorRequestId = generateId('req');
    request.cogitatorStartTime = Date.now();

    if (!authFn) {
      return;
    }

    try {
      const auth = await authFn(request);
      request.cogitatorAuth = auth;
    } catch (err) {
      request.log.warn({ err }, 'auth rejected request');
      if (reply.sent) return;
      return sendError(reply, 401, 'Unauthorized', 'UNAUTHORIZED');
    }
  };
}

/**
 * Answers `401 UNAUTHORIZED` to a caller without a user id when `anonymous` is `'deny'`.
 * Added to the API routes only, so health, ready and the docs stay open.
 */
export function createAnonymousHook(anonymous: AnonymousPolicy | undefined): onRequestHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const refusal = admitCaller(request.cogitatorAuth?.userId, anonymous);
    if (refusal && !reply.sent) return sendFailure(reply, refusal);
  };
}
