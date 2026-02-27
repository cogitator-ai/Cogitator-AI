import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Gateway, StreamBuffer } from '@cogitator-ai/channels';
import type { Channel, ChannelMessage } from '@cogitator-ai/types';

function createMockChannel(): Channel & {
  trigger: (msg: ChannelMessage) => void;
  sentTexts: string[];
  editedTexts: string[];
} {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  const sentTexts: string[] = [];
  const editedTexts: string[] = [];

  return {
    type: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: (h) => {
      handler = h;
    },
    sendText: vi.fn().mockImplementation((_chId: string, text: string) => {
      sentTexts.push(text);
      return Promise.resolve('msg_reply_1');
    }),
    editText: vi.fn().mockImplementation((_chId: string, _msgId: string, text: string) => {
      editedTexts.push(text);
      return Promise.resolve();
    }),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    trigger: (msg: ChannelMessage) => {
      if (handler) void handler(msg);
    },
    sentTexts,
    editedTexts,
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

describe('Channels E2E: Streaming', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    channel = createMockChannel();
  });

  it('StreamBuffer sends initial text then edits with accumulated content', async () => {
    const buffer = new StreamBuffer(channel, 'ch_1', {
      flushInterval: 50,
      minChunkSize: 5,
    });

    buffer.start();

    buffer.append('Hello ');
    await new Promise((r) => setTimeout(r, 80));

    buffer.append('world! This is a longer text.');
    await new Promise((r) => setTimeout(r, 80));

    await buffer.finish();

    expect(channel.sentTexts.length).toBe(1);
    expect(channel.sentTexts[0]).toBe('Hello ');

    expect(channel.editedTexts.length).toBeGreaterThanOrEqual(1);

    const lastEdit = channel.editedTexts[channel.editedTexts.length - 1];
    expect(lastEdit).toContain('Hello ');
    expect(lastEdit).toContain('world!');
  });

  it('StreamBuffer does not flush below minChunkSize', async () => {
    const buffer = new StreamBuffer(channel, 'ch_1', {
      flushInterval: 50,
      minChunkSize: 100,
    });

    buffer.start();
    buffer.append('Hi');
    await new Promise((r) => setTimeout(r, 80));

    expect(channel.sendText).not.toHaveBeenCalled();

    buffer.abort();
  });

  it('StreamBuffer force-flushes on finish even below minChunkSize', async () => {
    const buffer = new StreamBuffer(channel, 'ch_1', {
      flushInterval: 50,
      minChunkSize: 1000,
    });

    buffer.start();
    buffer.append('Short');
    await buffer.finish();

    expect(channel.sentTexts).toContain('Short');
  });

  it('Gateway in streaming mode sends progressive edits', async () => {
    let tokenCallback: ((token: string) => void) | null = null;

    const cogitator = {
      run: vi
        .fn()
        .mockImplementation(async (_agent: unknown, opts: { onToken?: (t: string) => void }) => {
          if (opts.onToken) {
            tokenCallback = opts.onToken;

            tokenCallback('Hello ');
            await new Promise((r) => setTimeout(r, 30));
            tokenCallback('world, ');
            await new Promise((r) => setTimeout(r, 30));
            tokenCallback('how are ');
            await new Promise((r) => setTimeout(r, 30));
            tokenCallback('you?');
          }
          return { output: 'Hello world, how are you?', toolCalls: [] };
        }),
    };

    const gateway = new Gateway({
      agent: { name: 'agent' } as never,
      channels: [channel],
      cogitator: cogitator as never,
      stream: { flushInterval: 40, minChunkSize: 5 },
    });

    await gateway.start();
    channel.trigger(createMsg({ text: 'Hi there' }));

    await vi.waitFor(
      () => {
        const totalCalls =
          (channel.sendText as ReturnType<typeof vi.fn>).mock.calls.length +
          (channel.editText as ReturnType<typeof vi.fn>).mock.calls.length;
        expect(totalCalls).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 }
    );

    expect(channel.sendTyping).toHaveBeenCalledWith('ch_1');

    await gateway.stop();
  });
});
