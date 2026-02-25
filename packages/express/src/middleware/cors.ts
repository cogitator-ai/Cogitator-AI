import type { Response, NextFunction, Request } from 'express';
import type { CorsConfig } from '../types.js';

function isOriginAllowed(origin: string | undefined, allowed: CorsConfig['origin']): boolean {
  if (!origin) return false;

  if (typeof allowed === 'string') {
    return allowed === '*' || allowed === origin;
  }

  if (Array.isArray(allowed)) {
    return allowed.includes(origin);
  }

  if (typeof allowed === 'function') {
    return allowed(origin);
  }

  return false;
}

export function createCorsMiddleware(config: CorsConfig) {
  const {
    origin,
    credentials = true,
    methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders = ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge = 86400,
  } = config;

  return (req: Request, res: Response, next: NextFunction) => {
    const requestOrigin = req.headers.origin;

    if (origin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (isOriginAllowed(requestOrigin, origin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin!);
      res.setHeader('Vary', 'Origin');
    }

    if (credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (exposedHeaders.length > 0) {
      res.setHeader('Access-Control-Expose-Headers', exposedHeaders.join(', '));
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));
      res.setHeader('Access-Control-Max-Age', maxAge.toString());
      res.status(204).end();
      return;
    }

    next();
  };
}
