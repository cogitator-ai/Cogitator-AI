import { describe, it, expect, vi } from 'vitest';
import { MessageQueue } from '../message-queue';
import type { ChannelMessage } from '@cogitator-ai/types';

function makeMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    channelType: 'telegram',
    channelId: 'ch1',
    userId: 'user1',
    text: 'hello',
    raw: {},
    ...overrides,
  };
}

function defer<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MessageQueue', () => {
  describe('parallel mode', () => {
    it('processes all messages immediately', () => {
      const processor = vi.fn().mockResolvedValue(undefined);
      const queue = new MessageQueue('parallel', processor);

      queue.push(makeMsg({ text: 'a' }), 'thread1');
      queue.push(makeMsg({ text: 'b' }), 'thread1');
      queue.push(makeMsg({ text: 'c' }), 'thread1');

      expect(processor).toHaveBeenCalledTimes(3);
      queue.dispose();
    });
  });

  describe('sequential mode', () => {
    it('processes second message after first completes', async () => {
      const order: string[] = [];
      const d1 = defer();
      const d2 = defer();

      let callCount = 0;
      const processor = vi.fn().mockImplementation(async (msg: ChannelMessage) => {
        const idx = callCount++;
        order.push(`start:${msg.text}`);
        await (idx === 0 ? d1.promise : d2.promise);
        order.push(`end:${msg.text}`);
      });

      const queue = new MessageQueue('sequential', processor);

      queue.push(makeMsg({ text: 'first' }), 'thread1');
      queue.push(makeMsg({ text: 'second' }), 'thread1');

      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['start:first']);

      d1.resolve();
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['start:first', 'end:first', 'start:second']);

      d2.resolve();
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);

      queue.dispose();
    });

    it('keeps threads independent', async () => {
      const calls: string[] = [];
      const d1 = defer();

      let firstCall = true;
      const processor = vi.fn().mockImplementation(async (msg: ChannelMessage) => {
        calls.push(msg.text);
        if (firstCall) {
          firstCall = false;
          await d1.promise;
        }
      });

      const queue = new MessageQueue('sequential', processor);

      queue.push(makeMsg({ text: 'thread1-msg' }), 'thread1');
      queue.push(makeMsg({ text: 'thread2-msg' }), 'thread2');

      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toContain('thread1-msg');
      expect(calls).toContain('thread2-msg');

      d1.resolve();
      queue.dispose();
    });
  });

  describe('interrupt mode', () => {
    it('aborts current processing for new message', async () => {
      const signals: AbortSignal[] = [];

      const processor = vi
        .fn()
        .mockImplementation(async (_msg: ChannelMessage, signal?: AbortSignal) => {
          if (signal) signals.push(signal);
          await new Promise((r) => setTimeout(r, 5000));
        });

      const queue = new MessageQueue('interrupt', processor);

      queue.push(makeMsg({ text: 'old' }), 'thread1');
      await new Promise((r) => setTimeout(r, 10));
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);

      queue.push(makeMsg({ text: 'new' }), 'thread1');
      expect(signals[0].aborted).toBe(true);
      expect(processor).toHaveBeenCalledTimes(2);

      queue.dispose();
    });
  });

  describe('collect mode', () => {
    it('merges buffered messages when idle', async () => {
      const d1 = defer();
      const processed: string[] = [];

      let firstCall = true;
      const processor = vi.fn().mockImplementation(async (msg: ChannelMessage) => {
        processed.push(msg.text);
        if (firstCall) {
          firstCall = false;
          await d1.promise;
        }
      });

      const queue = new MessageQueue('collect', processor);

      queue.push(makeMsg({ text: 'first' }), 'thread1');
      await new Promise((r) => setTimeout(r, 10));

      queue.push(makeMsg({ text: 'buffered1' }), 'thread1');
      queue.push(makeMsg({ text: 'buffered2' }), 'thread1');

      d1.resolve();
      await new Promise((r) => setTimeout(r, 10));

      expect(processed).toEqual(['first', 'buffered1\nbuffered2']);

      queue.dispose();
    });
  });
});
