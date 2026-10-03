import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';
import {
  findPendingByUser,
  generatePairingCode,
  isPairCommand,
  parsePairCommand,
  prunePending,
  type PendingPairing,
} from './pairing-codes';
import { expandHome } from '../paths';

export type DmPolicyMode = 'open' | 'allowlist' | 'pairing' | 'disabled';

export interface DmPolicyConfig {
  mode: DmPolicyMode;
  allowlist?: string[];
  /** Where approved users are persisted. A leading `~` expands to the home directory. */
  storePath?: string;
  pairingCodeLength?: number;
  pairingExpiresMs?: number;
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  groupAllowlist?: string[];
  ownerIds?: Record<string, string>;
  onPairingRequest?: (userId: string, code: string) => void;
  onStoreError?: (error: Error) => void;
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
  private readonly onStoreError?: (error: Error) => void;

  constructor(config: DmPolicyConfig) {
    this.mode = config.mode;
    this.storePath = config.storePath ? expandHome(config.storePath) : DEFAULT_STORE_PATH;
    this.codeLength = config.pairingCodeLength ?? DEFAULT_PAIRING_CODE_LENGTH;
    this.expiresMs = config.pairingExpiresMs ?? DEFAULT_PAIRING_EXPIRES_MS;
    this.groupPolicy = config.groupPolicy ?? 'open';
    this.groupAllowlist = new Set(config.groupAllowlist ?? []);
    this.onPairingRequest = config.onPairingRequest;
    this.onStoreError = config.onStoreError;

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
      if (this.mode === 'pairing' && isPairCommand(msg.text)) {
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
    const now = Date.now();
    prunePending(this.pending, now);

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
      expiresAt: now + this.expiresMs,
    });

    this.onPairingRequest?.(msg.userId, code);

    await ctx.channel.sendText(
      msg.channelId,
      `Hi! Ask the bot owner to approve you with: \`/pair ${code}\``
    );
  }

  private async handleApproval(msg: ChannelMessage, ctx: MiddlewareContext): Promise<void> {
    prunePending(this.pending, Date.now());
    const code = parsePairCommand(msg.text);
    const pairing = code ? this.pending.get(code) : undefined;

    if (!code || !pairing) {
      await ctx.channel.sendText(msg.channelId, 'Invalid or expired pairing code.');
      return;
    }

    const userKey = `${pairing.channelType}:${pairing.userId}`;
    this.approved.add(userKey);
    this.pending.delete(code);
    this.saveStore();

    await ctx.channel.sendText(msg.channelId, `User approved (${userKey}).`);
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
      const tmpPath = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(store, null, 2));
      renameSync(tmpPath, this.storePath);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.onStoreError) this.onStoreError(error);
      else console.error('[dm-policy] Failed to persist allowlist:', error.message);
    }
  }
}

export function dmPolicy(config: DmPolicyConfig): GatewayMiddleware {
  return new DmPolicyMiddleware(config);
}
