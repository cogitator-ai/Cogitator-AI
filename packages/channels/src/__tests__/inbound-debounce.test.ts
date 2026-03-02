import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InboundDebouncer } from '../inbound-debounce';
import type { ChannelMessage } from '@cogitator-ai/types';

function makeMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    channelType: 'telegram',
    channelId: 'ch1',
    userId: 'user1',
    userName: 'Alice',
    text: 'hello',
    raw: {},
    ...overrides,
  };
}

describe('InboundDebouncer', () => {
  let onFlush: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onFlush = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes single message after delay', () => {
    const debouncer = new InboundDebouncer({ delayMs: 500 }, onFlush);
    const msg = makeMsg({ text: 'hi' });
    debouncer.enqueue(msg);

    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0][0].text).toBe('hi');

    debouncer.dispose();
  });

  it('merges 3 rapid messages into 1 flush', () => {
    const debouncer = new InboundDebouncer({ delayMs: 500 }, onFlush);

    debouncer.enqueue(makeMsg({ id: 'm1', text: 'one' }));
    vi.advanceTimersByTime(100);
    debouncer.enqueue(makeMsg({ id: 'm2', text: 'two' }));
    vi.advanceTimersByTime(100);
    debouncer.enqueue(makeMsg({ id: 'm3', text: 'three' }));

    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const merged = onFlush.mock.calls[0][0];
    expect(merged.text).toBe('one\ntwo\nthree');
    expect(merged.id).toBe('m1');

    debouncer.dispose();
  });

  it('does not merge different users', () => {
    const debouncer = new InboundDebouncer({ delayMs: 500 }, onFlush);

    debouncer.enqueue(makeMsg({ userId: 'alice', text: 'hello' }));
    debouncer.enqueue(makeMsg({ userId: 'bob', text: 'world' }));

    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledTimes(2);

    debouncer.dispose();
  });

  it('does not merge different channels', () => {
    const debouncer = new InboundDebouncer({ delayMs: 500 }, onFlush);

    debouncer.enqueue(makeMsg({ channelId: 'ch1', text: 'a' }));
    debouncer.enqueue(makeMsg({ channelId: 'ch2', text: 'b' }));

    vi.advanceTimersByTime(500);

    expect(onFlush).toHaveBeenCalledTimes(2);

    debouncer.dispose();
  });

  it('uses per-channel delay override', () => {
    const debouncer = new InboundDebouncer({ delayMs: 1000, byChannel: { discord: 300 } }, onFlush);

    debouncer.enqueue(makeMsg({ channelType: 'discord', text: 'fast' }));

    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(1);

    debouncer.dispose();
  });

  it('flushAll processes all pending buffers', async () => {
    const debouncer = new InboundDebouncer({ delayMs: 5000 }, onFlush);

    debouncer.enqueue(makeMsg({ userId: 'a', text: 'x' }));
    debouncer.enqueue(makeMsg({ userId: 'b', text: 'y' }));

    await debouncer.flushAll();
    expect(onFlush).toHaveBeenCalledTimes(2);

    debouncer.dispose();
  });

  it('merges attachments from all messages', () => {
    const debouncer = new InboundDebouncer({ delayMs: 500 }, onFlush);

    debouncer.enqueue(
      makeMsg({
        text: 'photo',
        attachments: [{ type: 'image', mimeType: 'image/jpeg' }],
      })
    );
    debouncer.enqueue(
      makeMsg({
        text: 'voice',
        attachments: [{ type: 'audio', mimeType: 'audio/ogg' }],
      })
    );

    vi.advanceTimersByTime(500);

    const merged = onFlush.mock.calls[0][0];
    expect(merged.attachments).toHaveLength(2);

    debouncer.dispose();
  });
});
