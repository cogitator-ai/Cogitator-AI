import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export type DmPolicyMode = 'open' | 'allowlist' | 'pairing' | 'disabled';

export interface DmPolicyConfig {
  mode: DmPolicyMode;
  allowlist?: string[];
  storePath?: string;
  pairingCodeLength?: number;
  pairingExpiresMs?: number;
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowlist?: string[];
  ownerIds?: Record<string, string>;
  onPairingRequest?: (userId: string, code: string) => void;
}

interface PendingPairing {
  code: string;
  userId: string;
  channelType: string;
  expiresAt: number;
}

interface AllowStore {
  version: 1;
  users: string[];
}

const DEFAULT_STORE_PATH = join(homedir(), '.cogitator', 'dm-allowlist.json');
const DEFAULT_PAIRING_CODE_LENGTH = 6;
const DEFAULT_PAIRING_EXPIRES_MS = 300_000;

export class DmPolicyMiddleware implements GatewayMiddleware {
  readonly name = 'dm-policy';
  private readonly mode: DmPolicyMode;
  private readonly approved = new Set<string>();
  private readonly pending = new Map<string, PendingPairing>();
  private readonly storePath: string;
  private readonly codeLength: number;
  private readonly expiresMs: number;
  private readonly groupPolicy: 'open' | 'allowlist' | 'disabled';
  private readonly groupAllowlist: Set<string>;
  private readonly ownerKeys = new Set<string>();
  private readonly onPairingRequest?: (userId: string, code: string) => void;

  constructor(config: DmPolicyConfig) {
    this.mode = config.mode;
    this.storePath = config.storePath ?? DEFAULT_STORE_PATH;
    this.codeLength = config.pairingCodeLength ?? DEFAULT_PAIRING_CODE_LENGTH;
    this.expiresMs = config.pairingExpiresMs ?? DEFAULT_PAIRING_EXPIRES_MS;
    this.groupPolicy = config.groupPolicy ?? 'open';
    this.groupAllowlist = new Set(config.groupAllowlist ?? []);
    this.onPairingRequest = config.onPairingRequest;

    if (config.ownerIds) {
      for (const [channelType, ownerId] of Object.entries(config.ownerIds)) {
        this.ownerKeys.add(`${channelType}:${ownerId}`);
        this.approved.add(`${channelType}:${ownerId}`);
      }
    }

    if (config.allowlist) {
      for (const userId of config.allowlist) {
        this.approved.add(userId);
      }
    }

    this.loadStore();
  }

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    const isGroup = !!msg.groupId;
    const userKey = `${msg.channelType}:${msg.userId}`;
    const isOwner = this.ownerKeys.has(userKey);

    if (isGroup) {
      if (!this.checkGroupAccess(msg, isOwner)) return;
      await next();
      return;
    }

    if (isOwner) {
      if (this.mode === 'pairing' && msg.text.startsWith('/pair ')) {
        await this.handleApproval(msg, ctx);
        return;
      }
      await next();
      return;
    }

    switch (this.mode) {
      case 'open':
        await next();
        return;

      case 'disabled':
        return;

      case 'allowlist':
        if (this.isAllowed(userKey, msg.userId)) {
          await next();
        } else {
          await ctx.channel.sendText(msg.channelId, 'Not authorized.');
        }
        return;

      case 'pairing':
        if (this.isAllowed(userKey, msg.userId)) {
          await next();
          return;
        }
        await this.handlePairingRequest(msg, ctx, userKey);
        return;
    }
  }

  isApproved(channelType: string, userId: string): boolean {
    const userKey = `${channelType}:${userId}`;
    return this.isAllowed(userKey, userId);
  }

  getApprovedUsers(): readonly string[] {
    return [...this.approved];
  }

  private isAllowed(userKey: string, userId: string): boolean {
    return this.approved.has(userKey) || this.approved.has(userId);
  }

  private checkGroupAccess(msg: ChannelMessage, isOwner: boolean): boolean {
    switch (this.groupPolicy) {
      case 'open':
        return true;
      case 'disabled':
        return false;
      case 'allowlist':
        return isOwner || this.groupAllowlist.has(msg.groupId!);
    }
  }

  private async handlePairingRequest(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    userKey: string
  ): Promise<void> {
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
      expiresAt: Date.now() + this.expiresMs,
    });

    this.onPairingRequest?.(msg.userId, code);

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
    this.saveStore();

    await ctx.channel.sendText(msg.channelId, `User approved (${userKey}).`);
  }

  private findPendingByUser(userKey: string): PendingPairing | undefined {
    for (const p of this.pending.values()) {
      if (`${p.channelType}:${p.userId}` === userKey) return p;
    }
    return undefined;
  }

  private loadStore(): void {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = readFileSync(this.storePath, 'utf-8');
      const data = JSON.parse(raw) as AllowStore;
      if (data.version === 1 && Array.isArray(data.users)) {
        for (const userId of data.users) {
          this.approved.add(userId);
        }
      }
    } catch {}
  }

  private saveStore(): void {
    const store: AllowStore = {
      version: 1,
      users: [...this.approved].filter((key) => !this.ownerKeys.has(key)),
    };
    try {
      const dir = dirname(this.storePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.storePath, JSON.stringify(store, null, 2));
    } catch {}
  }
}

export function dmPolicy(config: DmPolicyConfig): GatewayMiddleware {
  return new DmPolicyMiddleware(config);
}
