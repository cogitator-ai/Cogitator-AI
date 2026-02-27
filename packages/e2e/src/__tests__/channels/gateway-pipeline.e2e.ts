import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Gateway } from '@cogitator-ai/channels';
import type { Channel, ChannelMessage } from '@cogitator-ai/types';

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

function createMockCogitator(output = 'Hello from AI') {
  return {
    run: vi.fn().mockResolvedValue({ output, toolCalls: [] }),
    close: vi.fn().mockResolvedValue(undefined),
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

describe('Channels E2E: Gateway Pipeline', () => {
  let channel: ReturnType<typeof createMockChannel>;
  let cogitator: ReturnType<typeof createMockCogitator>;

  beforeEach(() => {
    channel = createMockChannel();
    cogitator = createMockCogitator();
  });

  it('routes a message from channel through to agent and sends response', async () => {
    const gateway = new Gateway({
      agent: { name: 'test-agent', model: 'test/model', instructions: 'Be helpful' } as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();
    channel.trigger(createMsg({ text: 'What is 2+2?' }));

    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    expect(channel.sendTyping).toHaveBeenCalledWith('ch_1');
    expect(channel.sendText).toHaveBeenCalledWith('ch_1', 'Hello from AI', {
      replyTo: 'msg_1',
      format: 'markdown',
    });

    await gateway.stop();
  });

  it('starts and stops all channels', async () => {
    const ch1 = createMockChannel('telegram');
    const ch2 = createMockChannel('discord');

    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [ch1, ch2],
      cogitator: cogitator as never,
    });

    await gateway.start();
    expect(ch1.start).toHaveBeenCalled();
    expect(ch2.start).toHaveBeenCalled();

    await gateway.stop();
    expect(ch1.stop).toHaveBeenCalled();
    expect(ch2.stop).toHaveBeenCalled();
  });

  it('tracks stats: connected channels and message count', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();

    expect(gateway.stats.connectedChannels).toEqual(['test']);
    expect(gateway.stats.messagesToday).toBe(0);

    channel.trigger(createMsg());
    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    expect(gateway.stats.messagesToday).toBe(1);

    channel.trigger(createMsg({ id: 'msg_2', text: 'Second message' }));
    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalledTimes(2);
    });

    expect(gateway.stats.messagesToday).toBe(2);

    await gateway.stop();
  });

  it('generates default thread IDs as channelType:userId', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();
    channel.trigger(createMsg({ userId: 'alice', channelType: 'test' }));

    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    const runCall = cogitator.run.mock.calls[0];
    expect(runCall[1].threadId).toBe('test:alice');

    await gateway.stop();
  });

  it('supports custom threadKey function', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      session: {
        threadKey: (msg) => `custom:${msg.channelId}:${msg.userId}`,
      },
    });

    await gateway.start();
    channel.trigger(createMsg({ userId: 'bob', channelId: 'room_42' }));

    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalled();
    });

    const runCall = cogitator.run.mock.calls[0];
    expect(runCall[1].threadId).toBe('custom:room_42:bob');

    await gateway.stop();
  });

  it('resolves per-user agents via factory function', async () => {
    const adminAgent = { name: 'admin-agent', model: 'test/model' };
    const defaultAgent = { name: 'default-agent', model: 'test/model' };

    const factory = vi
      .fn()
      .mockImplementation((user) => (user.id === 'admin' ? adminAgent : defaultAgent));

    const gateway = new Gateway({
      agent: factory as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();

    channel.trigger(createMsg({ userId: 'admin' }));
    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalledTimes(1);
    });
    expect(cogitator.run.mock.calls[0][0]).toBe(adminAgent);

    channel.trigger(createMsg({ userId: 'regular_user', id: 'msg_2' }));
    await vi.waitFor(() => {
      expect(cogitator.run).toHaveBeenCalledTimes(2);
    });
    expect(cogitator.run.mock.calls[1][0]).toBe(defaultAgent);

    await gateway.stop();
  });

  it('calls onError when agent throws', async () => {
    const failingCogitator = {
      run: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    };
    const onError = vi.fn();

    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: failingCogitator as never,
      onError,
    });

    await gateway.start();
    channel.trigger(createMsg());

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });

    expect(onError.mock.calls[0][0].message).toBe('LLM timeout');
    expect(onError.mock.calls[0][1].id).toBe('msg_1');

    await gateway.stop();
  });

  it('ignores messages from unknown channel types', async () => {
    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
    });

    await gateway.start();
    channel.trigger(createMsg({ channelType: 'unknown_platform' }));

    await new Promise((r) => setTimeout(r, 100));
    expect(cogitator.run).not.toHaveBeenCalled();

    await gateway.stop();
  });
});
