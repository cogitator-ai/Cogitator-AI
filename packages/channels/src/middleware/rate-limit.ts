import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';

export interface RateLimitConfig {
  maxPerMinute: number;
  message?: string;
}

interface UserBucket {
  timestamps: number[];
}

export class RateLimitMiddleware implements GatewayMiddleware {
  readonly name = 'rate-limit';
  private buckets = new Map<string, UserBucket>();

  constructor(private readonly config: RateLimitConfig) {}

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    const userKey = `${msg.channelType}:${msg.userId}`;
    const now = Date.now();
    const windowMs = 60_000;

    let bucket = this.buckets.get(userKey);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(userKey, bucket);
    }

    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

    if (bucket.timestamps.length >= this.config.maxPerMinute) {
      const replyText =
        this.config.message ??
        `Rate limit exceeded. Please wait a moment before sending another message.`;
      await ctx.channel.sendText(msg.channelId, replyText);
      return;
    }

    bucket.timestamps.push(now);
    await next();
  }
}

export function rateLimit(config: RateLimitConfig): GatewayMiddleware {
  return new RateLimitMiddleware(config);
}
