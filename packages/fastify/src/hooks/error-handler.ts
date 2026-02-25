import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode } from '@cogitator-ai/types';

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

  request.log.error({ err: error }, 'unhandled error in cogitator plugin');

  reply.status(500).send({
    error: {
      message: 'Internal server error',
      code: ErrorCode.INTERNAL_ERROR,
    },
  });
}
