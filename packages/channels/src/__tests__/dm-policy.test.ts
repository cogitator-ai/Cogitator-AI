import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DmPolicyMiddleware } from '../middleware/dm-policy';
import type { ChannelMessage, MiddlewareContext, Channel } from '@cogitator-ai/types';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PAIR_CODE_RE = /`\/pair (\w+)`/;
const CODE_RE = /`(\w+)`/;

function extractPairCode(text: string): string | undefined {
  return PAIR_CODE_RE.exec(text)?.[1];
}

function extractCode(text: string): string | undefined {
  return CODE_RE.exec(text)?.[1];
}

function makeMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg1',
    channelType: 'telegram',
    channelId: 'ch1',
    userId: 'user1',
    text: 'hello',
    raw: {},
    ...overrides,
  };
}

function makeCtx(): MiddlewareContext & {
  channel: Channel & { sendText: ReturnType<typeof vi.fn> };
} {
  const channel = {
    type: 'telegram' as const,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue('msg_sent'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
  return {
    threadId: 'thread1',
    user: { id: 'user1', channelType: 'telegram' },
    channel,
    set: vi.fn(),
    get: vi.fn(),
  };
}

let tempStorePath: string;

beforeEach(() => {
  const dir = join(tmpdir(), 'cogitator-test-' + Date.now());
  mkdirSync(dir, { recursive: true });
  tempStorePath = join(dir, 'dm-allowlist.json');
});

afterEach(() => {
  try {
    if (existsSync(tempStorePath)) unlinkSync(tempStorePath);
  } catch {}
});

describe('DmPolicyMiddleware', () => {
  describe('mode: open', () => {
    it('allows all DMs', async () => {
      const mw = new DmPolicyMiddleware({ mode: 'open', storePath: tempStorePath });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg(), ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('allows unknown users', async () => {
      const mw = new DmPolicyMiddleware({ mode: 'open', storePath: tempStorePath });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg({ userId: 'stranger' }), ctx, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('mode: disabled', () => {
    it('blocks all DMs silently', async () => {
      const mw = new DmPolicyMiddleware({ mode: 'disabled', storePath: tempStorePath });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg(), ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.channel.sendText).not.toHaveBeenCalled();
    });
  });

  describe('mode: allowlist', () => {
    it('allows users in static allowlist', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'allowlist',
        allowlist: ['telegram:user1'],
        storePath: tempStorePath,
      });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg(), ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('allows users by bare userId in allowlist', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'allowlist',
        allowlist: ['user1'],
        storePath: tempStorePath,
      });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg(), ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('blocks users not in allowlist with message', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'allowlist',
        allowlist: ['telegram:other_user'],
        storePath: tempStorePath,
      });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg({ userId: 'stranger' }), ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.channel.sendText).toHaveBeenCalledWith('ch1', 'Not authorized.');
    });

    it('owners always pass allowlist', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'allowlist',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg({ userId: 'owner1' }), ctx, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('mode: pairing', () => {
    it('generates pairing code for unknown user', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });
      const next = vi.fn();
      const ctx = makeCtx();

      await mw.handle(makeMsg({ userId: 'newuser' }), ctx, next);

      expect(next).not.toHaveBeenCalled();
      const sentText = ctx.channel.sendText.mock.calls[0][1] as string;
      expect(sentText).toContain('/pair');
    });

    it('returns existing code on repeated request', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });
      const ctx1 = makeCtx();
      const ctx2 = makeCtx();

      await mw.handle(makeMsg({ userId: 'newuser' }), ctx1, vi.fn());
      await mw.handle(makeMsg({ userId: 'newuser' }), ctx2, vi.fn());

      const text1 = ctx1.channel.sendText.mock.calls[0][1] as string;
      const text2 = ctx2.channel.sendText.mock.calls[0][1] as string;
      const code1 = extractPairCode(text1);
      const code2 = extractCode(text2);
      expect(code1).toBe(code2);
    });

    it('owner approves pairing code', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });

      const userCtx = makeCtx();
      await mw.handle(makeMsg({ userId: 'newuser' }), userCtx, vi.fn());

      const sentText = userCtx.channel.sendText.mock.calls[0][1] as string;
      const code = extractPairCode(sentText);
      expect(code).toBeDefined();

      const ownerCtx = makeCtx();
      await mw.handle(makeMsg({ userId: 'owner1', text: `/pair ${code}` }), ownerCtx, vi.fn());

      expect(ownerCtx.channel.sendText.mock.calls[0][1]).toContain('approved');

      const nextAfterApproval = vi.fn();
      await mw.handle(makeMsg({ userId: 'newuser' }), makeCtx(), nextAfterApproval);
      expect(nextAfterApproval).toHaveBeenCalled();
    });

    it('rejects invalid pairing code', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });
      const ctx = makeCtx();

      await mw.handle(makeMsg({ userId: 'owner1', text: '/pair INVALID' }), ctx, vi.fn());

      expect(ctx.channel.sendText.mock.calls[0][1]).toContain('Invalid');
    });

    it('calls onPairingRequest callback', async () => {
      const onPairing = vi.fn();
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        onPairingRequest: onPairing,
        storePath: tempStorePath,
      });

      await mw.handle(makeMsg({ userId: 'newuser' }), makeCtx(), vi.fn());

      expect(onPairing).toHaveBeenCalledWith('newuser', expect.any(String));
    });

    it('allows already-approved users', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        allowlist: ['telegram:friend1'],
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });
      const next = vi.fn();

      await mw.handle(makeMsg({ userId: 'friend1' }), makeCtx(), next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('group policy', () => {
    const groupMsg = (overrides: Partial<ChannelMessage> = {}) =>
      makeMsg({ groupId: 'group1', ...overrides });

    it('groupPolicy: open allows all groups', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'disabled',
        groupPolicy: 'open',
        storePath: tempStorePath,
      });
      const next = vi.fn();

      await mw.handle(groupMsg(), makeCtx(), next);

      expect(next).toHaveBeenCalled();
    });

    it('groupPolicy: disabled blocks all groups', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'open',
        groupPolicy: 'disabled',
        storePath: tempStorePath,
      });
      const next = vi.fn();

      await mw.handle(groupMsg(), makeCtx(), next);

      expect(next).not.toHaveBeenCalled();
    });

    it('groupPolicy: allowlist blocks non-listed groups', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'open',
        groupPolicy: 'allowlist',
        groupAllowlist: ['group_allowed'],
        storePath: tempStorePath,
      });
      const next = vi.fn();

      await mw.handle(groupMsg({ groupId: 'group_other' }), makeCtx(), next);

      expect(next).not.toHaveBeenCalled();
    });

    it('groupPolicy: allowlist allows listed groups', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'open',
        groupPolicy: 'allowlist',
        groupAllowlist: ['group1'],
        storePath: tempStorePath,
      });
      const next = vi.fn();

      await mw.handle(groupMsg(), makeCtx(), next);

      expect(next).toHaveBeenCalled();
    });

    it('owners bypass group allowlist', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'open',
        groupPolicy: 'allowlist',
        groupAllowlist: [],
        ownerIds: { telegram: 'user1' },
        storePath: tempStorePath,
      });
      const next = vi.fn();

      await mw.handle(groupMsg(), makeCtx(), next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('persistent store', () => {
    it('saves approved users to file after pairing', async () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });

      const userCtx = makeCtx();
      await mw.handle(makeMsg({ userId: 'newuser' }), userCtx, vi.fn());
      const sentText = userCtx.channel.sendText.mock.calls[0][1] as string;
      const code = extractPairCode(sentText) ?? '';
      expect(code).not.toBe('');

      await mw.handle(makeMsg({ userId: 'owner1', text: `/pair ${code}` }), makeCtx(), vi.fn());

      expect(existsSync(tempStorePath)).toBe(true);
      const stored = JSON.parse(readFileSync(tempStorePath, 'utf-8'));
      expect(stored.version).toBe(1);
      expect(stored.users).toContain('telegram:newuser');
    });

    it('loads approved users from file on construction', async () => {
      const mw1 = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });

      const userCtx = makeCtx();
      await mw1.handle(makeMsg({ userId: 'newuser' }), userCtx, vi.fn());
      const sentText = userCtx.channel.sendText.mock.calls[0][1] as string;
      const code = extractPairCode(sentText) ?? '';
      expect(code).not.toBe('');
      await mw1.handle(makeMsg({ userId: 'owner1', text: `/pair ${code}` }), makeCtx(), vi.fn());

      const mw2 = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });

      const next = vi.fn();
      await mw2.handle(makeMsg({ userId: 'newuser' }), makeCtx(), next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('isApproved', () => {
    it('returns true for owners', () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        ownerIds: { telegram: 'owner1' },
        storePath: tempStorePath,
      });

      expect(mw.isApproved('telegram', 'owner1')).toBe(true);
    });

    it('returns false for unknown users', () => {
      const mw = new DmPolicyMiddleware({
        mode: 'pairing',
        storePath: tempStorePath,
      });

      expect(mw.isApproved('telegram', 'stranger')).toBe(false);
    });
  });
});
