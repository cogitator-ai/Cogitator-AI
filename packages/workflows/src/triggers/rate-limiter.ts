/**
 * Rate Limiter
 *
 * Token bucket algorithm implementation for rate limiting
 * with support for burst limits and sliding windows.
 */

/**
 * Token bucket configuration
 */
export interface TokenBucketConfig {
  /** Maximum number of tokens (requests per window) */
  capacity: number;
  /** Window size in milliseconds */
  window: number;
  /** Burst limit - maximum tokens that can be consumed at once */
  burstLimit?: number;
  /** Initial token count (defaults to capacity) */
  initialTokens?: number;
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * Token bucket rate limiter
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly burstLimit: number;

  constructor(config: TokenBucketConfig) {
    this.capacity = config.capacity;
    this.burstLimit = config.burstLimit ?? config.capacity;
    this.tokens = config.initialTokens ?? config.capacity;
    this.lastRefill = Date.now();
    this.refillRate = config.capacity / config.window;
  }

  /**
   * Try to consume tokens
   */
  consume(count: number = 1): RateLimitResult {
    this.refill();

    if (count > this.burstLimit) {
      return {
        allowed: false,
        remaining: Math.floor(this.tokens),
        resetAt: this.calculateResetAt(),
        retryAfter: undefined,
      };
    }

    if (this.tokens >= count) {
      this.tokens -= count;
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        resetAt: this.calculateResetAt(),
      };
    }

    const tokensNeeded = count - this.tokens;
    const retryAfter = Math.ceil(tokensNeeded / this.refillRate);

    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      resetAt: this.calculateResetAt(),
      retryAfter,
    };
  }

  /**
   * Check if tokens are available without consuming
   */
  check(count: number = 1): RateLimitResult {
    this.refill();

    if (this.tokens >= count) {
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        resetAt: this.calculateResetAt(),
      };
    }

    const tokensNeeded = count - this.tokens;
    const retryAfter = Math.ceil(tokensNeeded / this.refillRate);

    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      resetAt: this.calculateResetAt(),
      retryAfter,
    };
  }

  /**
   * Get current token count
   */
  getTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Reset the bucket to full capacity
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  private calculateResetAt(): number {
    const tokensNeeded = this.capacity - this.tokens;
    const timeToFull = tokensNeeded / this.refillRate;
    return Date.now() + timeToFull;
  }
}

/**
 * Rate limiter that manages multiple buckets by key
 */
export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly config: TokenBucketConfig;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(config: TokenBucketConfig, cleanupIntervalMs: number = 60000) {
    this.config = config;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  /**
   * Check rate limit for a key
   */
  check(key: string, count: number = 1): RateLimitResult {
    const bucket = this.getBucket(key);
    return bucket.check(count);
  }

  /**
   * Consume tokens for a key
   */
  consume(key: string, count: number = 1): RateLimitResult {
    const bucket = this.getBucket(key);
    return bucket.consume(count);
  }

  /**
   * Reset rate limit for a key
   */
  reset(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.reset();
    }
  }

  /**
   * Remove a key's bucket
   */
  remove(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Get all tracked keys
   */
  getKeys(): string[] {
    return Array.from(this.buckets.keys());
  }

  /**
   * Dispose the rate limiter
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.buckets.clear();
  }

  private getBucket(key: string): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.config);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private cleanup(): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.getTokens() >= this.config.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * Sliding window rate limiter
 * More accurate than token bucket for some use cases
 */
export class SlidingWindowRateLimiter {
  private windows = new Map<string, { timestamps: number[] }>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(maxRequests: number, windowMs: number, cleanupIntervalMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }

  /**
   * Check if request is allowed and record it
   */
  consume(key: string): RateLimitResult {
    const now = Date.now();
    const window = this.getWindow(key);

    const cutoff = now - this.windowMs;
    window.timestamps = window.timestamps.filter(t => t > cutoff);

    if (window.timestamps.length >= this.maxRequests) {
      const oldestInWindow = window.timestamps[0];
      const resetAt = oldestInWindow + this.windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: resetAt - now,
      };
    }

    window.timestamps.push(now);

    return {
      allowed: true,
      remaining: this.maxRequests - window.timestamps.length,
      resetAt: now + this.windowMs,
    };
  }

  /**
   * Check without consuming
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window) {
      return {
        allowed: true,
        remaining: this.maxRequests,
        resetAt: now + this.windowMs,
      };
    }

    const cutoff = now - this.windowMs;
    const validTimestamps = window.timestamps.filter(t => t > cutoff);

    if (validTimestamps.length >= this.maxRequests) {
      const oldestInWindow = validTimestamps[0];
      const resetAt = oldestInWindow + this.windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: resetAt - now,
      };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - validTimestamps.length,
      resetAt: now + this.windowMs,
    };
  }

  /**
   * Reset a key's window
   */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Dispose the rate limiter
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.windows.clear();
  }

  private getWindow(key: string): { timestamps: number[] } {
    let window = this.windows.get(key);
    if (!window) {
      window = { timestamps: [] };
      this.windows.set(key, window);
    }
    return window;
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    for (const [key, window] of this.windows) {
      window.timestamps = window.timestamps.filter(t => t > cutoff);
      if (window.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}

/**
 * Create a token bucket rate limiter
 */
export function createRateLimiter(config: TokenBucketConfig): RateLimiter {
  return new RateLimiter(config);
}

/**
 * Create a sliding window rate limiter
 */
export function createSlidingWindowLimiter(
  maxRequests: number,
  windowMs: number
): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter(maxRequests, windowMs);
}
