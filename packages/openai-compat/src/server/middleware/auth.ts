/**
 * Authentication Middleware
 *
 * Validates API keys for the OpenAI-compatible server.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

export interface AuthConfig {
  /** List of valid API keys. If empty, auth is disabled. */
  apiKeys: string[];

  /** Whether to require authentication */
  required: boolean;
}

/**
 * Create authentication middleware
 */
export function createAuthMiddleware(config: AuthConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.apiKeys.length === 0 && !config.required) {
      return;
    }

    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return reply.status(401).send({
        error: {
          message: 'Missing Authorization header',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return reply.status(401).send({
        error: {
          message: 'Invalid Authorization header format. Expected: Bearer <api_key>',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }

    const apiKey = match[1];

    if (config.apiKeys.length > 0 && !config.apiKeys.includes(apiKey)) {
      return reply.status(401).send({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
  };
}

