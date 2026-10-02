import { describe, it, expect, vi } from 'vitest';
import { StreamBuffer } from '../stream-buffer';
import type { Channel } from '@cogitator-ai/types';

function createChannel(): Channel & {
  sendText: ReturnType<typeof vi.fn>;
  editText: ReturnType<typeof vi.fn>;
  sendDraft: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  return {
    type: 'test',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    sendText: vi.fn().mockImplementation(() => Promise.resolve(`m${++n}`)),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn(),
    sendTyping: vi.fn(),
    sendDraft: vi.fn().mockResolvedValue(undefined),
  };
}

describe('StreamBuffer regressions', () => {
  it('forceNewMessage commits unflushed text to the current message', async () => {
    const channel = createChannel();
    const buffer = new StreamBuffer(channel, 'c', { flushInterval: 10_000, minChunkSize: 1 });

    buffer.append('first part');
    buffer.forceNewMessage();
    buffer.append('second part');
    await buffer.finish();

    expect(channel.sendText.mock.calls.map((c) => c[1])).toEqual(['first part', 'second part']);
    expect(buffer.getMessageIds()).toEqual(['m1', 'm2']);
  });

  it('only the first message carries replyTo', async () => {
    const channel = createChannel();
    const buffer = new StreamBuffer(
      channel,
      'c',
      { flushInterval: 10_000, minChunkSize: 1, maxMessageChars: 6 },
      'orig'
    );

    buffer.append('aaaa bbbb cccc');
    await buffer.finish();

    const replyTos = channel.sendText.mock.calls.map((c) => (c[2] as { replyTo?: string }).replyTo);
    expect(replyTos[0]).toBe('orig');
    expect(replyTos.slice(1).every((r) => r === undefined)).toBe(true);
  });

  it('finish() rethrows a failed final delivery', async () => {
    const channel = createChannel();
    channel.sendText.mockRejectedValueOnce(new Error('network down'));
    const buffer = new StreamBuffer(channel, 'c', { flushInterval: 10_000, minChunkSize: 1 });

    buffer.append('hello');
    await expect(buffer.finish()).rejects.toThrow('network down');
  });

  it('draft mode commits overflowed text as real messages', async () => {
    const channel = createChannel();
    const buffer = new StreamBuffer(
      channel,
      'c',
      { flushInterval: 10_000, minChunkSize: 1, maxMessageChars: 10 },
      undefined,
      true
    );

    buffer.append('alpha beta gamma delta');
    await buffer.finish();

    const texts = channel.sendText.mock.calls.map((c) => c[1] as string);
    expect(texts.join(' ')).toBe('alpha beta gamma delta');
    expect(texts.every((t) => t.length <= 10)).toBe(true);
  });

  it('final edit updates the streamed message with the complete text', async () => {
    const channel = createChannel();
    const buffer = new StreamBuffer(channel, 'c', { flushInterval: 20, minChunkSize: 1 });

    buffer.start();
    buffer.append('Hello');
    await new Promise((r) => setTimeout(r, 50));
    buffer.append(' world');
    await buffer.finish();

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(channel.editText).toHaveBeenLastCalledWith('c', 'm1', 'Hello world');
  });
});

describe('StreamBuffer formatting', () => {
  it('formats every outgoing text while deduplicating on raw text', async () => {
    const channel = createChannel();
    const buffer = new StreamBuffer(
      channel,
      'c',
      { flushInterval: 20, minChunkSize: 1 },
      undefined,
      false,
      (text) => text.toUpperCase()
    );

    buffer.start();
    buffer.append('hello');
    await new Promise((r) => setTimeout(r, 50));
    buffer.append(' world');
    await buffer.finish();

    expect(channel.sendText.mock.calls[0][1]).toBe('HELLO');
    expect(channel.editText).toHaveBeenLastCalledWith('c', 'm1', 'HELLO WORLD');
  });
});
