import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMIT_EXCEEDED',
};

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (reply.sent) {
    return;
  }

  if (CogitatorError.isCogitatorError(error)) {
    const statusCode = ERROR_STATUS_CODES[error.code] || 500;
    reply.status(statusCode).send({
      error: {
        message: error.message,
        code: error.code,
      },
    });
    return;
  }

  if (error.validation) {
    reply.status(400).send({
      error: {
        message: error.message,
        code: 'INVALID_INPUT',
        details: error.validation,
      },
    });
    return;
  }

  const statusCode = error.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    reply.status(statusCode).send({
      error: {
        message: error.message,
        code: CLIENT_ERROR_CODES[statusCode] ?? error.code ?? 'BAD_REQUEST',
      },
    });
    return;
  }

  request.log.error({ err: error }, 'unhandled error in cogitator plugin');

  reply.status(500).send({
    error: {
      message: 'Internal server error',
      code: ErrorCode.INTERNAL_ERROR,
    },
  });
}
