import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Gateway } from '../gateway';
import type {
  Channel,
  ChannelMessage,
  GatewayMiddleware,
  MiddlewareContext,
} from '@cogitator-ai/types';

function createMockChannel(
  type = 'test'
): Channel & { triggerMessage: (msg: ChannelMessage) => Promise<void> } {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  return {
    type,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((h) => {
      handler = h;
    }),
    sendText: vi.fn().mockResolvedValue('sent_001'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    triggerMessage: async (msg: ChannelMessage) => {
      if (handler) await handler(msg);
    },
  };
}

function createMockCogitator() {
  return {
    run: vi.fn().mockResolvedValue({ output: 'Agent response', usage: { totalTokens: 100 } }),
    close: vi.fn(),
  };
}

function createTestMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
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

describe('Gateway', () => {
  let channel: ReturnType<typeof createMockChannel>;
  let cogitator: ReturnType<typeof createMockCogitator>;

  beforeEach(() => {
    channel = createMockChannel();
    cogitator = createMockCogitator();
  });

  it('starts and stops all channels', async () => {
    const gateway = new Gateway({
      agent: {
        name: 'test',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();
    expect(channel.start).toHaveBeenCalled();

    await gateway.stop();
    expect(channel.stop).toHaveBeenCalled();
  });

  it('routes messages to cogitator.run()', async () => {
    const agent = {
      name: 'bot',
      id: 'a1',
      model: 'test/m',
      instructions: 'hi',
      tools: [],
      config: {},
    } as never;
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage());

    expect(channel.sendTyping).toHaveBeenCalledWith('ch_1');
    expect(cogitator.run).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({
        input: 'Hello',
        threadId: 'test:user_1',
      })
    );
    expect(channel.sendText).toHaveBeenCalledWith(
      'ch_1',
      'Agent response',
      expect.objectContaining({ replyTo: 'msg_1' })
    );
  });

  it('custom threadKey works', async () => {
    const gateway = new Gateway({
      agent: {
        name: 'bot',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
      session: {
        threadKey: (msg) => `custom:${msg.userId}:${msg.channelId}`,
      },
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage());

    expect(cogitator.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 'custom:user_1:ch_1' })
    );
  });

  it('runs on threads it derives itself as shared, so group chats take every member', async () => {
    const gateway = new Gateway({
      agent: { name: 'bot', id: 'a1', instructions: 'hi', tools: [], config: {} } as never,
      channels: [channel],
      cogitator: cogitator as never,
      session: { threadKey: (msg) => `group:${msg.channelId}` },
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage({ userId: 'user_1' }));
    await channel.triggerMessage(createTestMessage({ id: 'msg_2', userId: 'user_2' }));

    const calls = vi.mocked(cogitator.run).mock.calls.map(([, options]) => options);
    expect(calls).toEqual([
      expect.objectContaining({ threadId: 'group:ch_1', userId: 'user_1', threadAccess: 'shared' }),
      expect.objectContaining({ threadId: 'group:ch_1', userId: 'user_2', threadAccess: 'shared' }),
    ]);
  });

  it('middleware can block messages', async () => {
    const blockMiddleware: GatewayMiddleware = {
      name: 'blocker',
      async handle(_msg: ChannelMessage, _ctx: MiddlewareContext, _next: () => Promise<void>) {},
    };

    const gateway = new Gateway({
      agent: {
        name: 'bot',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [blockMiddleware],
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage());

    expect(cogitator.run).not.toHaveBeenCalled();
  });

  it('middleware can pass messages', async () => {
    const passMiddleware: GatewayMiddleware = {
      name: 'passer',
      async handle(_msg: ChannelMessage, _ctx: MiddlewareContext, next: () => Promise<void>) {
        await next();
      },
    };

    const gateway = new Gateway({
      agent: {
        name: 'bot',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
      middleware: [passMiddleware],
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage());

    expect(cogitator.run).toHaveBeenCalled();
  });

  it('error handler receives errors', async () => {
    cogitator.run.mockRejectedValue(new Error('LLM down'));
    const onError = vi.fn();

    const gateway = new Gateway({
      agent: {
        name: 'bot',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
      onError,
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage());

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ id: 'msg_1' })
    );
  });

  it('reports stats', async () => {
    const gateway = new Gateway({
      agent: {
        name: 'bot',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    expect(gateway.stats.uptime).toBe(0);

    await gateway.start();
    expect(gateway.stats.connectedChannels).toEqual(['test']);
    expect(gateway.stats.messagesToday).toBe(0);

    await channel.triggerMessage(createTestMessage());
    expect(gateway.stats.messagesToday).toBe(1);
  });

  it('agent factory receives user', async () => {
    const agentFactory = vi.fn().mockReturnValue({
      name: 'dynamic',
      id: 'a2',
      model: 'test/m',
      instructions: 'hi',
      tools: [],
      config: {},
    });

    const gateway = new Gateway({
      agent: agentFactory,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();
    await channel.triggerMessage(createTestMessage({ userName: 'Alice' }));

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_1', name: 'Alice' })
    );
  });
});

describe('Gateway with a channel that cannot edit', () => {
  it('sends the finished answer once instead of streaming it into edits', async () => {
    const channel = { ...createMockChannel(), editable: false };
    const cogitator = {
      run: vi.fn(
        async (_agent: unknown, options: { stream?: boolean; onToken?: (t: string) => void }) => {
          expect(options.stream).toBeFalsy();
          return { output: 'The whole answer', usage: { totalTokens: 10 } };
        }
      ),
      close: vi.fn(),
    };
    const gateway = new Gateway({
      agent: {
        name: 'test',
        id: 'a1',
        model: 'test/m',
        instructions: 'hi',
        tools: [],
        config: {},
      } as never,
      channels: [channel],
      cogitator: cogitator as never,
      stream: { flushInterval: 10, minChunkSize: 1 },
    });
    await gateway.start();
    await channel.triggerMessage(createTestMessage());
    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(channel.sendText).toHaveBeenCalledWith('ch_1', 'The whole answer', expect.anything());
    expect(channel.editText).not.toHaveBeenCalled();
    await gateway.stop();
  });
});
