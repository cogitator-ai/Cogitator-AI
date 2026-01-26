import type { Response, NextFunction, Request } from 'express';
import type { RateLimitConfig, CogitatorRequest } from '../types.js';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const store = new Map<string, RateLimitEntry>();

function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetTime <= now) {
      store.delete(key);
    }
  }
}

setInterval(cleanupExpired, 60000);

function defaultKeyGenerator(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function createRateLimitMiddleware(config: RateLimitConfig) {
  const {
    windowMs,
    max,
    message = 'Too many requests, please try again later',
    keyGenerator = defaultKeyGenerator,
    skip,
  } = config;

  return (req: CogitatorRequest, res: Response, next: NextFunction) => {
    if (skip?.(req)) {
      return next();
    }

    const key = keyGenerator(req);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { count: 0, resetTime: now + windowMs };
      store.set(key, entry);
    }

    entry.count++;

    const remaining = Math.max(0, max - entry.count);
    const resetSeconds = Math.ceil((entry.resetTime - now) / 1000);

    res.setHeader('X-RateLimit-Limit', max.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', resetSeconds.toString());

    if (entry.count > max) {
      res.setHeader('Retry-After', resetSeconds.toString());
      res.status(429).json({
        error: {
          message,
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });
      return;
    }

    next();
  };
}
