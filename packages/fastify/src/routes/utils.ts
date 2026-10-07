import type { FastifyReply, FastifyRequest, preValidationAsyncHookHandler } from 'fastify';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';
import type { ParseResult } from '@cogitator-ai/server-shared';

export function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  code: string
): FastifyReply {
  return reply.status(status).send({ error: { message, code } });
}

export function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
  );
}

export interface ResolvedError {
  status: number;
  message: string;
  code: string;
}

/**
 * What a client may see of an error: a `CogitatorError` as it is, anything
 * else as `500 Internal server error`, logged through `source.log` (a request
 * or the server).
 */
export function resolveError(
  source: Pick<FastifyRequest, 'log'>,
  error: unknown,
  label: string
): ResolvedError {
  if (CogitatorError.isCogitatorError(error)) {
    return {
      status: ERROR_STATUS_CODES[error.code] || 500,
      message: error.message,
      code: error.code,
    };
  }
  source.log.error({ err: error }, label);
  return { status: 500, message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR };
}

export function sendRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  label: string
): FastifyReply {
  const resolved = resolveError(request, error, label);
  return sendError(reply, resolved.status, resolved.message, resolved.code);
}

export function onClientDisconnect(reply: FastifyReply, handler: () => void): void {
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) handler();
  });
}

/**
 * A `preValidation` hook that reads the body with the shared validator every adapter uses
 * and puts the validated value in its place. It runs before the JSON schema, whose type
 * coercion would otherwise turn `input: 42` into `"42"`, so Fastify refuses exactly what
 * the other adapters refuse, and the schema only documents the body.
 */
export function validateBody<T>(
  parse: (body: unknown) => ParseResult<T>
): preValidationAsyncHookHandler {
  return async (request, reply) => {
    const parsed = parse(request.body);
    if (!parsed.ok) return sendError(reply, 400, parsed.message, 'INVALID_INPUT');
    request.body = parsed.value;
  };
}
