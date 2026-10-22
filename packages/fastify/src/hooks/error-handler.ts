import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { INTERNAL_ERROR, describeHttpError, errorEnvelope } from '@cogitator-ai/server-shared';
import { sendFailure } from '../routes/utils.js';

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

  const described = describeHttpError(error);
  if (described) {
    sendFailure(reply, described);
    return;
  }

  if (error.validation) {
    const refusal = { status: 400, code: 'INVALID_INPUT', message: error.message };
    reply.status(400).send({
      error: { ...errorEnvelope(refusal).error, details: error.validation },
    });
    return;
  }

  const statusCode = error.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    sendFailure(reply, {
      status: statusCode,
      code: CLIENT_ERROR_CODES[statusCode] ?? error.code ?? 'BAD_REQUEST',
      message: error.message,
    });
    return;
  }

  request.log.error({ err: error }, 'unhandled error in cogitator plugin');
  sendFailure(reply, INTERNAL_ERROR);
}
