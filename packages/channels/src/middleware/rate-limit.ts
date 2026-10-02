import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';

export interface RateLimitConfig {
  maxPerMinute: number;
  message?: string;
}

interface UserBucket {
  timestamps: number[];
  notified: boolean;
}

const WINDOW_MS = 60_000;

export class RateLimitMiddleware implements GatewayMiddleware {
  readonly name = 'rate-limit';
  private readonly buckets = new Map<string, UserBucket>();
  private lastSweep = 0;

  constructor(private readonly config: RateLimitConfig) {}

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    const userKey = `${msg.channelType}:${msg.userId}`;
    const now = Date.now();
    this.sweep(now);

    let bucket = this.buckets.get(userKey);
    if (!bucket) {
      bucket = { timestamps: [], notified: false };
      this.buckets.set(userKey, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((t) => now - t < WINDOW_MS);

    if (bucket.timestamps.length >= this.config.maxPerMinute) {
      if (!bucket.notified) {
        bucket.notified = true;
        await ctx.channel.sendText(
          msg.channelId,
          this.config.message ??
            'Rate limit exceeded. Please wait a moment before sending another message.'
        );
      }
      return;
    }

    bucket.notified = false;
    bucket.timestamps.push(now);
    await next();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < WINDOW_MS) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.timestamps.every((t) => now - t >= WINDOW_MS)) {
        this.buckets.delete(key);
      }
    }
  }
}

export function rateLimit(config: RateLimitConfig): GatewayMiddleware {
  return new RateLimitMiddleware(config);
}
