import { describe, it, expect, vi } from 'vitest';
import { StreamBuffer } from '../stream-buffer';
import type { Channel } from '@cogitator-ai/types';

function createMockChannel(): Channel {
  return {
    type: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue('msg_001'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
  };
}

function createDraftChannel(): Channel & { sendDraft: ReturnType<typeof vi.fn> } {
  return {
    type: 'telegram',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue('msg_final'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendDraft: vi.fn().mockResolvedValue(undefined),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('StreamBuffer', () => {
  it('sends first chunk via sendText on flush', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(channel, 'ch1', {
      flushInterval: 50,
      minChunkSize: 1,
    });

    buffer.start();
    buffer.append('Hello world');

    await wait(100);

    expect(channel.sendText).toHaveBeenCalledWith('ch1', 'Hello world', {
      replyTo: undefined,
      format: 'markdown',
    });

    buffer.abort();
  });

  it('uses editText for subsequent flushes', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(channel, 'ch1', {
      flushInterval: 50,
      minChunkSize: 1,
    });

    buffer.start();
    buffer.append('Hello');

    await wait(80);

    buffer.append(' world');

    await wait(80);

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(channel.editText).toHaveBeenCalledWith('ch1', 'msg_001', 'Hello world');

    buffer.abort();
  });

  it('skips flush when buffer is below minChunkSize', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(channel, 'ch1', {
      flushInterval: 50,
      minChunkSize: 100,
    });

    buffer.start();
    buffer.append('Hi');

    await wait(80);

    expect(channel.sendText).not.toHaveBeenCalled();

    buffer.abort();
  });

  it('finish() forces final flush regardless of minChunkSize', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(channel, 'ch1', {
      flushInterval: 10000,
      minChunkSize: 1000,
    });

    buffer.append('Short');
    const msgId = await buffer.finish();

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(msgId).toBe('msg_001');
  });

  it('abort() stops interval without final flush', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(channel, 'ch1', {
      flushInterval: 50,
      minChunkSize: 1,
    });

    buffer.start();
    buffer.append('Hello');
    buffer.abort();

    await wait(100);

    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it('passes replyTo to sendText', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(
      channel,
      'ch1',
      {
        flushInterval: 100,
        minChunkSize: 1,
      },
      'reply_123'
    );

    buffer.append('Hello');
    await buffer.finish();

    expect(channel.sendText).toHaveBeenCalledWith('ch1', 'Hello', {
      replyTo: 'reply_123',
      format: 'markdown',
    });
  });

  it('finish returns empty string when buffer is empty', async () => {
    const channel = createMockChannel();
    const buffer = new StreamBuffer(channel, 'ch1', {
      flushInterval: 100,
      minChunkSize: 1,
    });

    const msgId = await buffer.finish();

    expect(msgId).toBe('');
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  describe('draft mode', () => {
    it('uses sendDraft instead of sendText during streaming', async () => {
      const channel = createDraftChannel();
      const buffer = new StreamBuffer(
        channel,
        'ch1',
        { flushInterval: 50, minChunkSize: 1 },
        undefined,
        true
      );

      buffer.start();
      buffer.append('Hello');
      await wait(80);

      expect(channel.sendDraft).toHaveBeenCalledTimes(1);
      const [chId, draftId, text] = channel.sendDraft.mock.calls[0];
      expect(chId).toBe('ch1');
      expect(draftId).toBeGreaterThan(0);
      expect(text).toBe('Hello');
      expect(channel.sendText).not.toHaveBeenCalled();
      expect(channel.editText).not.toHaveBeenCalled();

      buffer.abort();
    });

    it('sends final message via sendText on finish', async () => {
      const channel = createDraftChannel();
      const buffer = new StreamBuffer(
        channel,
        'ch1',
        { flushInterval: 10000, minChunkSize: 1 },
        'reply_1',
        true
      );

      buffer.append('Full response');
      const msgId = await buffer.finish();

      expect(msgId).toBe('msg_final');
      expect(channel.sendText).toHaveBeenCalledWith('ch1', 'Full response', {
        replyTo: 'reply_1',
        format: 'markdown',
      });
    });

    it('keeps same draftId across flushes', async () => {
      const channel = createDraftChannel();
      const buffer = new StreamBuffer(
        channel,
        'ch1',
        { flushInterval: 50, minChunkSize: 1 },
        undefined,
        true
      );

      buffer.start();
      buffer.append('Hi');
      await wait(80);
      buffer.append(' there');
      await wait(80);

      const calls = channel.sendDraft.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const ids = calls.map((c: unknown[]) => c[1]);
      const allSame = ids.every((id: number) => id === ids[0]);
      expect(allSame).toBe(true);

      buffer.abort();
    });

    it('falls back to edit mode if sendDraft fails', async () => {
      const channel = createDraftChannel();
      channel.sendDraft.mockRejectedValueOnce(new Error('draft not supported'));
      const buffer = new StreamBuffer(
        channel,
        'ch1',
        { flushInterval: 50, minChunkSize: 1 },
        undefined,
        true
      );

      buffer.start();
      buffer.append('Hello');
      await wait(80);

      buffer.append(' world');
      await wait(80);

      expect(channel.sendDraft).toHaveBeenCalledTimes(1);
      expect(channel.sendText).toHaveBeenCalledTimes(1);

      buffer.abort();
    });

    it('does not use draft mode if channel lacks sendDraft', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(
        channel,
        'ch1',
        { flushInterval: 50, minChunkSize: 1 },
        undefined,
        true
      );

      buffer.start();
      buffer.append('Hello');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      buffer.abort();
    });
  });
});
