import { describe, it, expect, vi } from 'vitest';
import { OwnerCommandsMiddleware } from '../middleware/owner-commands';
import type { ChannelMessage, MiddlewareContext, Channel } from '@cogitator-ai/types';

function createMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg_1',
    channelType: 'telegram',
    channelId: 'ch_1',
    userId: 'owner_1',
    text: '/status',
    raw: {},
    ...overrides,
  };
}

function createCtx(): MiddlewareContext {
  const store = new Map<string, unknown>();
  return {
    threadId: 'thread_1',
    user: { id: 'owner_1', channelType: 'telegram' },
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

describe('OwnerCommandsMiddleware', () => {
  it('handles /status for owner', async () => {
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
      onStatus: () => 'Up 2h, 5 sessions',
    });

    const ctx = createCtx();
    const next = vi.fn();
    await mw.handle(createMsg({ text: '/status' }), ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.channel.sendText).toHaveBeenCalledWith('ch_1', 'Up 2h, 5 sessions');
  });

  it('passes non-command messages to next', async () => {
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const next = vi.fn();
    await mw.handle(createMsg({ text: 'Hello there' }), createCtx(), next);

    expect(next).toHaveBeenCalled();
  });

  it('passes unknown commands to next', async () => {
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const next = vi.fn();
    await mw.handle(createMsg({ text: '/unknown_cmd' }), createCtx(), next);

    expect(next).toHaveBeenCalled();
  });

  it('ignores commands from non-owners', async () => {
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const next = vi.fn();
    await mw.handle(createMsg({ userId: 'stranger', text: '/status' }), createCtx(), next);

    expect(next).toHaveBeenCalled();
  });

  it('/help returns command list', async () => {
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
    });

    const ctx = createCtx();
    await mw.handle(createMsg({ text: '/help' }), ctx, vi.fn());

    const sendCall = (ctx.channel.sendText as ReturnType<typeof vi.fn>).mock.calls[0];
    const response = sendCall[1] as string;
    expect(response).toContain('/status');
    expect(response).toContain('/sessions');
    expect(response).toContain('/model');
  });

  it('/model parses args', async () => {
    const onModel = vi.fn().mockReturnValue('Model switched');
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
      onModel,
    });

    const ctx = createCtx();
    await mw.handle(createMsg({ text: '/model claude-opus @user' }), ctx, vi.fn());

    expect(onModel).toHaveBeenCalledWith('claude-opus', '@user');
    expect(ctx.channel.sendText).toHaveBeenCalledWith('ch_1', 'Model switched');
  });

  it('/compact calls handler', async () => {
    const onCompact = vi.fn().mockResolvedValue('Compacted 50 messages');
    const mw = new OwnerCommandsMiddleware({
      ownerIds: { telegram: 'owner_1' },
      onCompact,
    });

    const ctx = createCtx();
    await mw.handle(createMsg({ text: '/compact all' }), ctx, vi.fn());

    expect(onCompact).toHaveBeenCalledWith('all');
    expect(ctx.channel.sendText).toHaveBeenCalledWith('ch_1', 'Compacted 50 messages');
  });
});
