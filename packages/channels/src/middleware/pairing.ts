import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export interface PairingConfig {
  ownerIds: Record<string, string>;
  codeLength?: number;
  expiresIn?: number;
}

interface PendingPairing {
  code: string;
  userId: string;
  channelType: string;
  expiresAt: number;
}

export class PairingMiddleware implements GatewayMiddleware {
  readonly name = 'pairing';
  private approved = new Set<string>();
  private pending = new Map<string, PendingPairing>();
  private readonly codeLength: number;
  private readonly expiresIn: number;

  constructor(config: PairingConfig) {
    this.codeLength = config.codeLength ?? 6;
    this.expiresIn = (config.expiresIn ?? 300) * 1000;

    for (const [channelType, ownerId] of Object.entries(config.ownerIds)) {
      this.approved.add(`${channelType}:${ownerId}`);
    }
  }

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    const userKey = `${msg.channelType}:${msg.userId}`;

    if (this.approved.has(userKey)) {
      if (msg.text.startsWith('/pair ')) {
        await this.handleApproval(msg, ctx);
        return;
      }
      await next();
      return;
    }

    const existing = this.findPendingByUser(userKey);
    if (existing && existing.expiresAt > Date.now()) {
      await ctx.channel.sendText(
        msg.channelId,
        `Waiting for approval. Your code: \`${existing.code}\``
      );
      return;
    }

    const code = nanoid(this.codeLength).toUpperCase();
    this.pending.set(code, {
      code,
      userId: msg.userId,
      channelType: msg.channelType,
      expiresAt: Date.now() + this.expiresIn,
    });

    await ctx.channel.sendText(
      msg.channelId,
      `Hi! Ask the bot owner to approve you with: \`/pair ${code}\``
    );
  }

  private async handleApproval(msg: ChannelMessage, ctx: MiddlewareContext): Promise<void> {
    const code = msg.text.replace('/pair ', '').trim().toUpperCase();
    const pairing = this.pending.get(code);

    if (!pairing) {
      await ctx.channel.sendText(msg.channelId, 'Invalid or expired pairing code.');
      return;
    }

    if (pairing.expiresAt < Date.now()) {
      this.pending.delete(code);
      await ctx.channel.sendText(msg.channelId, 'Pairing code expired.');
      return;
    }

    const userKey = `${pairing.channelType}:${pairing.userId}`;
    this.approved.add(userKey);
    this.pending.delete(code);

    await ctx.channel.sendText(msg.channelId, `User approved (${userKey}).`);
  }

  private findPendingByUser(userKey: string): PendingPairing | undefined {
    for (const p of this.pending.values()) {
      if (`${p.channelType}:${p.userId}` === userKey) return p;
    }
    return undefined;
  }

  isApproved(channelType: string, userId: string): boolean {
    return this.approved.has(`${channelType}:${userId}`);
  }
}

export function pairing(config: PairingConfig): GatewayMiddleware {
  return new PairingMiddleware(config);
}
