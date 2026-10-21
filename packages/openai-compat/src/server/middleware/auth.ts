/**
 * Authentication Middleware
 *
 * Validates API keys for the OpenAI-compatible server.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Who the request acts for: the sha256 hex digest of the API key it authenticated with,
     * never the key itself. Undefined when the server has no API keys, then nothing is scoped.
     */
    apiKeyOwner?: string;
  }
}

export interface AuthConfig {
  /** List of valid API keys. If empty, auth is disabled. */
  apiKeys: string[];

  /** Whether to require authentication */
  required: boolean;

  /** Paths that never require authentication (exact match, e.g. '/health') */
  publicPaths?: string[];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Constant-time key check: every configured key is compared, and digests make
 * the comparison independent of the candidate's length.
 */
function isValidKey(candidateDigest: Buffer, keys: Buffer[]): boolean {
  let valid = false;
  for (const key of keys) {
    if (timingSafeEqual(candidateDigest, key)) valid = true;
  }
  return valid;
}

/** The owner identity of an API key: its sha256 hex digest, so the key itself is never stored. */
export function apiKeyOwner(apiKey: string): string {
  return digest(apiKey).toString('hex');
}

/**
 * Create authentication middleware. A request that passes with one of `apiKeys` gets
 * `request.apiKeyOwner`, which scopes the threads and runs it creates and reaches to that key.
 */
export function createAuthMiddleware(config: AuthConfig) {
  const keyDigests = config.apiKeys.map(digest);
  const publicPaths = new Set(config.publicPaths ?? []);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.apiKeys.length === 0 && !config.required) {
      return;
    }

    const path = request.url.split('?')[0];
    if (publicPaths.has(path)) {
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

    const match = /^Bearer\s(.+)$/i.exec(authHeader);
    if (!match) {
      return reply.status(401).send({
        error: {
          message: 'Invalid Authorization header format. Expected: Bearer <api_key>',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }

    if (keyDigests.length === 0) return;

    const candidateDigest = digest(match[1].trim());
    if (!isValidKey(candidateDigest, keyDigests)) {
      return reply.status(401).send({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
    request.apiKeyOwner = candidateDigest.toString('hex');
  };
}
