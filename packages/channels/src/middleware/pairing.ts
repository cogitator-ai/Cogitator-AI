import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';
import {
  findPendingByUser,
  generatePairingCode,
  isPairCommand,
  parsePairCommand,
  prunePending,
  type PendingPairing,
} from './pairing-codes';

export interface PairingConfig {
  ownerIds: Record<string, string>;
  codeLength?: number;
  expiresIn?: number;
}

export class PairingMiddleware implements GatewayMiddleware {
  readonly name = 'pairing';
  private readonly ownerKeys = new Set<string>();
  private readonly approved = new Set<string>();
  private readonly pending = new Map<string, PendingPairing>();
  private readonly codeLength: number;
  private readonly expiresIn: number;

  constructor(config: PairingConfig) {
    this.codeLength = config.codeLength ?? 6;
    this.expiresIn = (config.expiresIn ?? 300) * 1000;

    for (const [channelType, ownerId] of Object.entries(config.ownerIds)) {
      const key = `${channelType}:${ownerId}`;
      this.ownerKeys.add(key);
      this.approved.add(key);
    }
  }

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    const userKey = `${msg.channelType}:${msg.userId}`;
    const now = Date.now();
    prunePending(this.pending, now);

    if (this.ownerKeys.has(userKey) && isPairCommand(msg.text)) {
      await this.handleApproval(msg, ctx);
      return;
    }

    if (this.approved.has(userKey)) {
      await next();
      return;
    }

    const existing = findPendingByUser(this.pending, userKey);
    if (existing) {
      await ctx.channel.sendText(
        msg.channelId,
        `Waiting for approval. Your code: \`${existing.code}\``
      );
      return;
    }

    const code = generatePairingCode(this.codeLength);
    this.pending.set(code, {
      code,
      userId: msg.userId,
      channelType: msg.channelType,
      expiresAt: now + this.expiresIn,
    });

    await ctx.channel.sendText(
      msg.channelId,
      `Hi! Ask the bot owner to approve you with: \`/pair ${code}\``
    );
  }

  private async handleApproval(msg: ChannelMessage, ctx: MiddlewareContext): Promise<void> {
    const code = parsePairCommand(msg.text);
    const pairing = code ? this.pending.get(code) : undefined;

    if (!code || !pairing) {
      await ctx.channel.sendText(msg.channelId, 'Invalid or expired pairing code.');
      return;
    }

    const userKey = `${pairing.channelType}:${pairing.userId}`;
    this.approved.add(userKey);
    this.pending.delete(code);

    await ctx.channel.sendText(msg.channelId, `User approved (${userKey}).`);
  }

  isApproved(channelType: string, userId: string): boolean {
    return this.approved.has(`${channelType}:${userId}`);
  }
}

export function pairing(config: PairingConfig): GatewayMiddleware {
  return new PairingMiddleware(config);
}
