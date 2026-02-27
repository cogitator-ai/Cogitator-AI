import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Gateway, pairing, rateLimit, ownerCommands } from '@cogitator-ai/channels';
import type {
  Channel,
  ChannelMessage,
  GatewayMiddleware,
  MiddlewareContext,
} from '@cogitator-ai/types';

function createMockChannel(type = 'test'): Channel & { trigger: (msg: ChannelMessage) => void } {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  return {
    type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: (h) => {
      handler = h;
    },
    sendText: vi.fn().mockResolvedValue('sent_1'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    trigger: (msg: ChannelMessage) => {
      if (handler) void handler(msg);
    },
  };
}

function createMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg_1',
    channelType: 'test',
    channelId: 'ch_1',
    userId: 'user_1',
    text: 'Hello',
    raw: {},
    ...overrides,
  };
}

describe('Channels E2E: Middleware Chain', () => {
  let channel: ReturnType<typeof createMockChannel>;
  let cogitator: { run: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    channel = createMockChannel();
    cogitator = {
      run: vi.fn().mockResolvedValue({ output: 'response', toolCalls: [] }),
    };
  });

  it('executes middleware in order and tracks execution', async () => {
    const order: string[] = [];

    const mw1: GatewayMiddleware = {
      name: 'first',
      async handle(_msg, _ctx, next) {
        order.push('first-before');
        await next();
        order.push('first-after');
      },
    };

    const mw2: GatewayMiddleware = {
      name: 'second',
      async handle(_msg, _ctx, next) {
        order.push('second-before');
        await next();
        order.push('second-after');
      },
    };

    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [mw1, mw2],
    });

    await gateway.start();
    channel.trigger(createMsg());

    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    expect(order).toEqual(['first-before', 'second-before', 'second-after', 'first-after']);

    await gateway.stop();
  });

  it('blocks message when middleware does not call next()', async () => {
    const blocker: GatewayMiddleware = {
      name: 'blocker',
      async handle(msg, ctx) {
        await ctx.channel.sendText(msg.channelId, 'Blocked!');
      },
    };

    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [blocker],
    });

    await gateway.start();
    channel.trigger(createMsg());

    await vi.waitFor(() => {
      expect(channel.sendText).toHaveBeenCalledWith('ch_1', 'Blocked!');
    });

    expect(cogitator.run).not.toHaveBeenCalled();

    await gateway.stop();
  });

  it('middleware can share data via ctx.set/get', async () => {
    const setter: GatewayMiddleware = {
      name: 'setter',
      async handle(_msg, ctx, next) {
        ctx.set('role', 'admin');
        ctx.set('tier', 'premium');
        await next();
      },
    };

    let capturedRole: string | undefined;
    let capturedTier: string | undefined;

    const reader: GatewayMiddleware = {
      name: 'reader',
      async handle(_msg, ctx, next) {
        capturedRole = ctx.get<string>('role');
        capturedTier = ctx.get<string>('tier');
        await next();
      },
    };

    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [setter, reader],
    });

    await gateway.start();
    channel.trigger(createMsg());

    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    expect(capturedRole).toBe('admin');
    expect(capturedTier).toBe('premium');

    await gateway.stop();
  });

  it('rate limiter blocks after exceeding limit', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [rateLimit({ maxPerMinute: 2, message: 'Slow down!' })],
    });

    await gateway.start();

    channel.trigger(createMsg({ id: 'msg_1' }));
    await vi.waitFor(() => expect(cogitator.run).toHaveBeenCalledTimes(1));

    channel.trigger(createMsg({ id: 'msg_2', text: 'Second' }));
    await vi.waitFor(() => expect(cogitator.run).toHaveBeenCalledTimes(2));

    channel.trigger(createMsg({ id: 'msg_3', text: 'Third — should be blocked' }));

    await vi.waitFor(() => {
      const calls = (channel.sendText as ReturnType<typeof vi.fn>).mock.calls;
      const blockedCall = calls.find((c: unknown[]) => c[1] === 'Slow down!');
      expect(blockedCall).toBeDefined();
    });

    expect(cogitator.run).toHaveBeenCalledTimes(2);

    await gateway.stop();
  });

  it('owner commands intercept /status from owner', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [
        ownerCommands({
          ownerIds: { test: 'owner_1' },
          onStatus: () => 'Running for 2h',
        }),
      ],
    });

    await gateway.start();
    channel.trigger(createMsg({ userId: 'owner_1', text: '/status' }));

    await vi.waitFor(() => {
      expect(channel.sendText).toHaveBeenCalledWith('ch_1', 'Running for 2h');
    });

    expect(cogitator.run).not.toHaveBeenCalled();

    await gateway.stop();
  });

  it('owner commands pass through for non-owners', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [
        ownerCommands({
          ownerIds: { test: 'owner_1' },
          onStatus: () => 'Status info',
        }),
      ],
    });

    await gateway.start();
    channel.trigger(createMsg({ userId: 'stranger', text: '/status' }));

    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    await gateway.stop();
  });

  it('multiple middleware compose correctly: owner commands + rate limit', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [
        ownerCommands({ ownerIds: { test: 'admin' } }),
        rateLimit({ maxPerMinute: 100 }),
      ],
    });

    await gateway.start();

    channel.trigger(createMsg({ userId: 'admin', text: '/help' }));
    await vi.waitFor(() => {
      const calls = (channel.sendText as ReturnType<typeof vi.fn>).mock.calls;
      const helpCall = calls.find(
        (c: unknown[]) => typeof c[1] === 'string' && c[1].includes('/status')
      );
      expect(helpCall).toBeDefined();
    });
    expect(cogitator.run).not.toHaveBeenCalled();

    channel.trigger(createMsg({ userId: 'regular', text: 'Hello' }));
    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalledTimes(1);
    });

    await gateway.stop();
  });
});
