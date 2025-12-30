/**
 * Error Handler Middleware
 *
 * Formats errors in OpenAI-compatible format.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { OpenAIError } from '../../types/openai-types.js';

/**
 * OpenAI-compatible error response
 */
export function formatOpenAIError(
  code: string,
  message: string,
  type: string = 'invalid_request_error',
  param?: string
): OpenAIError {
  return {
    error: {
      message,
      type,
      param,
      code,
    },
  };
}

/**
 * Error handler for Fastify
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  request.log.error(error);

  let statusCode = error.statusCode ?? 500;

  let errorType = 'server_error';
  let errorCode = 'internal_error';

  if (statusCode === 400) {
    errorType = 'invalid_request_error';
    errorCode = 'invalid_request';
  } else if (statusCode === 401) {
    errorType = 'invalid_request_error';
    errorCode = 'invalid_api_key';
  } else if (statusCode === 403) {
    errorType = 'invalid_request_error';
    errorCode = 'permission_denied';
  } else if (statusCode === 404) {
    errorType = 'invalid_request_error';
    errorCode = 'not_found';
  } else if (statusCode === 429) {
    errorType = 'rate_limit_error';
    errorCode = 'rate_limit_exceeded';
  }

  return reply.status(statusCode).send(
    formatOpenAIError(
      errorCode,
      error.message,
      errorType
    )
  );
}

/**
 * Not found handler for Fastify
 */
export function notFoundHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  return reply.status(404).send(
    formatOpenAIError(
      'not_found',
      `The requested resource ${request.url} was not found`,
      'invalid_request_error'
    )
  );
}

