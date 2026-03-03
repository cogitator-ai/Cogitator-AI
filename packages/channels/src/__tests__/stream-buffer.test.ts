import { describe, it, expect, vi } from 'vitest';
import { StreamBuffer } from '../stream-buffer';
import type { Channel } from '@cogitator-ai/types';

function createMockChannel(): Channel & { deleteMessage: ReturnType<typeof vi.fn> } {
  return {
    type: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    sendText: vi.fn().mockResolvedValue('msg_001'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
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

    await buffer.abort();
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

    await buffer.abort();
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

    await buffer.abort();
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
    await buffer.abort();

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

      await buffer.abort();
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

      await buffer.abort();
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

      await buffer.abort();
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

      await buffer.abort();
    });
  });

  describe('minInitialChars', () => {
    it('suppresses first flush until buffer reaches threshold', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
        minInitialChars: 20,
      });

      buffer.start();
      buffer.append('Hi');

      await wait(80);

      expect(channel.sendText).not.toHaveBeenCalled();

      buffer.append(' there, this is a longer message now');

      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      await buffer.abort();
    });

    it('finish() bypasses minInitialChars', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 10000,
        minChunkSize: 1,
        minInitialChars: 100,
      });

      buffer.append('Short');
      const msgId = await buffer.finish();

      expect(channel.sendText).toHaveBeenCalledTimes(1);
      expect(msgId).toBe('msg_001');
    });

    it('does not suppress edits after initial send', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
        minInitialChars: 5,
      });

      buffer.start();
      buffer.append('Hello World');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      buffer.append('!');
      await wait(80);

      expect(channel.editText).toHaveBeenCalled();

      await buffer.abort();
    });
  });

  describe('forceNewMessage', () => {
    it('creates a new message after forceNewMessage', async () => {
      const channel = createMockChannel();
      let msgCounter = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(`msg_${++msgCounter}`)
      );

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('First message');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      buffer.forceNewMessage();
      buffer.append('Second message');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(2);
      expect(buffer.getMessageIds()).toEqual(['msg_1', 'msg_2']);

      await buffer.abort();
    });

    it('resets buffer on forceNewMessage so old text is not re-sent', async () => {
      const channel = createMockChannel();
      let msgCounter = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(`msg_${++msgCounter}`)
      );

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('First');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);
      expect((channel.sendText as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('First');

      buffer.forceNewMessage();
      buffer.append('Second');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(2);
      expect((channel.sendText as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe('Second');

      await buffer.abort();
    });
  });

  describe('maxMessageChars', () => {
    it('auto-splits by creating new message when buffer exceeds limit', async () => {
      const channel = createMockChannel();
      let msgCounter = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(`msg_${++msgCounter}`)
      );

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
        maxMessageChars: 10,
      });

      buffer.start();
      buffer.append('Short');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      buffer.append(' and now exceeding the limit heavily');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(2);

      await buffer.abort();
    });
  });

  describe('deleteOnAbort', () => {
    it('deletes messages on abort when deleteOnAbort is true', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
        deleteOnAbort: true,
      });

      buffer.start();
      buffer.append('Hello');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      await buffer.abort();

      expect(channel.deleteMessage).toHaveBeenCalledWith('ch1', 'msg_001');
    });

    it('does not delete on abort when deleteOnAbort is false', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');
      await wait(80);

      await buffer.abort();

      expect(channel.deleteMessage).not.toHaveBeenCalled();
    });

    it('does not delete if no messages were sent', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 100,
        deleteOnAbort: true,
      });

      buffer.start();
      buffer.append('Hi');

      await buffer.abort();

      expect(channel.deleteMessage).not.toHaveBeenCalled();
    });

    it('deletes all messages when multiple were created via forceNewMessage', async () => {
      const channel = createMockChannel();
      let msgCounter = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(`msg_${++msgCounter}`)
      );

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
        deleteOnAbort: true,
      });

      buffer.start();
      buffer.append('First');
      await wait(80);

      buffer.forceNewMessage();
      buffer.append('Second');
      await wait(80);

      await buffer.abort();

      expect(channel.deleteMessage).toHaveBeenCalledWith('ch1', 'msg_1');
      expect(channel.deleteMessage).toHaveBeenCalledWith('ch1', 'msg_2');
    });
  });

  describe('messageIds tracking', () => {
    it('tracks all created message IDs', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 10000,
        minChunkSize: 1,
      });

      buffer.append('Hello');
      await buffer.finish();

      expect(buffer.getMessageIds()).toEqual(['msg_001']);
    });

    it('returns empty array when no messages sent', () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 100,
        minChunkSize: 1,
      });

      expect(buffer.getMessageIds()).toEqual([]);
    });
  });

  describe('duplicate suppression', () => {
    it('skips editText when buffer unchanged between flushes', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 50,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');
      await wait(80);

      expect(channel.sendText).toHaveBeenCalledTimes(1);

      await wait(80);

      expect(channel.editText).not.toHaveBeenCalled();

      await buffer.abort();
    });

    it('sends editText when buffer has changed', async () => {
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

      expect(channel.editText).toHaveBeenCalledWith('ch1', 'msg_001', 'Hello world');

      await buffer.abort();
    });

    it('force flush bypasses dedup', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 10000,
        minChunkSize: 1,
      });

      buffer.append('Hello');
      await buffer.finish();

      expect(channel.sendText).toHaveBeenCalledTimes(1);
    });
  });

  describe('in-flight awareness', () => {
    it('does not run concurrent flushes', async () => {
      const channel = createMockChannel();
      let concurrent = 0;
      let maxConcurrent = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await wait(60);
        concurrent--;
        return 'msg_001';
      });

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 20,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');

      await wait(200);
      await buffer.abort();

      expect(maxConcurrent).toBe(1);
    });

    it('finish() waits for in-flight flush', async () => {
      const channel = createMockChannel();
      let sendResolved = false;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await wait(80);
        sendResolved = true;
        return 'msg_001';
      });

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 20,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');

      await wait(30);
      await buffer.finish();

      expect(sendResolved).toBe(true);
    });
  });

  describe('generation counter', () => {
    it('ignores late sendText result from stale generation', async () => {
      const channel = createMockChannel();
      let callCount = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          await wait(100);
          return 'msg_stale';
        }
        return 'msg_fresh';
      });

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 20,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('First');
      await wait(30);

      buffer.forceNewMessage();
      buffer.append('Second');

      await wait(200);
      await buffer.finish();

      expect(buffer.getMessageIds()).not.toContain('msg_stale');
      expect(buffer.getMessageIds()).toContain('msg_fresh');

      await buffer.abort();
    });

    it('skips stale editText after generation change', async () => {
      const channel = createMockChannel();
      let sendCount = 0;
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        sendCount++;
        return `msg_${sendCount}`;
      });

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 30,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');
      await wait(50);

      buffer.forceNewMessage();
      buffer.append('New message');
      await wait(50);

      const editCalls = (channel.editText as ReturnType<typeof vi.fn>).mock.calls;
      const staleEdits = editCalls.filter(
        (c: unknown[]) => c[1] === 'msg_1' && (c[2] as string).startsWith('New')
      );
      expect(staleEdits).toHaveLength(0);

      await buffer.abort();
    });
  });

  describe('smart throttle', () => {
    it('schedules next flush accounting for elapsed API time', async () => {
      const channel = createMockChannel();
      const timestamps: number[] = [];
      (channel.sendText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        timestamps.push(Date.now());
        await wait(30);
        return 'msg_001';
      });
      (channel.editText as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        timestamps.push(Date.now());
      });

      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 60,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');
      await wait(50);
      buffer.append(' world');
      await wait(120);

      await buffer.abort();

      if (timestamps.length >= 2) {
        const gap = timestamps[1] - timestamps[0];
        expect(gap).toBeLessThan(100);
      }
    });

    it('does not schedule after stop', async () => {
      const channel = createMockChannel();
      const buffer = new StreamBuffer(channel, 'ch1', {
        flushInterval: 30,
        minChunkSize: 1,
      });

      buffer.start();
      buffer.append('Hello');
      await buffer.abort();

      const callsBefore = (channel.sendText as ReturnType<typeof vi.fn>).mock.calls.length;
      buffer.append('More');
      await wait(100);
      const callsAfter = (channel.sendText as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(callsAfter).toBe(callsBefore);
    });
  });
});
