import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PairingMiddleware } from '../middleware/pairing';
import { RateLimitMiddleware } from '../middleware/rate-limit';
import type { ChannelMessage, MiddlewareContext, Channel } from '@cogitator-ai/types';

function createMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg_1',
    channelType: 'telegram',
    channelId: 'ch_1',
    userId: 'user_1',
    text: 'Hello',
    raw: {},
    ...overrides,
  };
}

function createCtx(): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    threadId: 'thread_1',
    user: { id: 'user_1', channelType: 'telegram' },
    channel: {
      type: 'telegram',
      start: vi.fn(),
      stop: vi.fn(),
      onMessage: vi.fn(),
      sendText: vi.fn().mockResolvedValue('sent_1'),
      editText: vi.fn(),
      sendFile: vi.fn(),
      sendTyping: vi.fn(),
    } as Channel,
    set: (k: string, v: unknown) => store.set(k, v),
    get: <T>(k: string) => store.get(k) as T | undefined,
  };
}

describe('PairingMiddleware', () => {
  it('allows owner through immediately', async () => {
    const mw = new PairingMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const next = vi.fn();
    await mw.handle(createMsg({ userId: 'owner_1' }), createCtx(), next);

    expect(next).toHaveBeenCalled();
  });

  it('blocks unknown users', async () => {
    const mw = new PairingMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const ctx = createCtx();
    const next = vi.fn();
    await mw.handle(createMsg({ userId: 'stranger' }), ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.channel.sendText).toHaveBeenCalled();
  });

  it('approves user with valid code', async () => {
    const mw = new PairingMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const ctx = createCtx();
    const strangerNext = vi.fn();
    await mw.handle(createMsg({ userId: 'stranger' }), ctx, strangerNext);

    expect(strangerNext).not.toHaveBeenCalled();

    const sendTextCall = (ctx.channel.sendText as ReturnType<typeof vi.fn>).mock.calls[0];
    const codeMatch = (sendTextCall[1] as string).match(/`\/pair (.+?)`/);
    expect(codeMatch).toBeTruthy();
    const code = codeMatch![1];

    const ownerCtx = createCtx();
    const ownerNext = vi.fn();
    await mw.handle(createMsg({ userId: 'owner_1', text: `/pair ${code}` }), ownerCtx, ownerNext);

    expect(mw.isApproved('telegram', 'stranger')).toBe(true);

    const approvedNext = vi.fn();
    await mw.handle(createMsg({ userId: 'stranger' }), createCtx(), approvedNext);
    expect(approvedNext).toHaveBeenCalled();
  });

  it('rejects invalid code', async () => {
    const mw = new PairingMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const ctx = createCtx();
    await mw.handle(createMsg({ userId: 'owner_1', text: '/pair INVALID' }), ctx, vi.fn());

    expect(ctx.channel.sendText).toHaveBeenCalledWith('ch_1', 'Invalid or expired pairing code.');
  });
});

describe('RateLimitMiddleware', () => {
  it('allows messages within limit', async () => {
    const mw = new RateLimitMiddleware({ maxPerMinute: 5 });
    const next = vi.fn();

    for (let i = 0; i < 5; i++) {
      await mw.handle(createMsg(), createCtx(), next);
    }

    expect(next).toHaveBeenCalledTimes(5);
  });

  it('blocks messages exceeding limit', async () => {
    const mw = new RateLimitMiddleware({ maxPerMinute: 2 });
    const next = vi.fn();
    const ctx = createCtx();

    await mw.handle(createMsg(), ctx, next);
    await mw.handle(createMsg(), ctx, next);
    await mw.handle(createMsg(), ctx, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(ctx.channel.sendText).toHaveBeenCalledTimes(1);
  });

  it('custom rate limit message', async () => {
    const mw = new RateLimitMiddleware({
      maxPerMinute: 1,
      message: 'Slow down!',
    });

    const ctx = createCtx();
    await mw.handle(createMsg(), ctx, vi.fn());
    await mw.handle(createMsg(), ctx, vi.fn());

    expect(ctx.channel.sendText).toHaveBeenCalledWith('ch_1', 'Slow down!');
  });
});
