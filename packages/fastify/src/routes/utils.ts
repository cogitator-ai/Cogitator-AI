import type { FastifyReply, FastifyRequest } from 'fastify';
import { CogitatorError, ERROR_STATUS_CODES } from '@cogitator-ai/types';

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

export function resolveError(
  request: FastifyRequest,
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
  request.log.error({ err: error }, label);
  return { status: 500, message: 'Internal server error', code: 'INTERNAL' };
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
