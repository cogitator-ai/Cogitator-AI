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

      void queue.push(makeMsg({ text: 'a' }), 'thread1');
      void queue.push(makeMsg({ text: 'b' }), 'thread1');
      void queue.push(makeMsg({ text: 'c' }), 'thread1');

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

      void queue.push(makeMsg({ text: 'first' }), 'thread1');
      void queue.push(makeMsg({ text: 'second' }), 'thread1');

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

      void queue.push(makeMsg({ text: 'thread1-msg' }), 'thread1');
      void queue.push(makeMsg({ text: 'thread2-msg' }), 'thread2');

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

      void queue.push(makeMsg({ text: 'old' }), 'thread1');
      await new Promise((r) => setTimeout(r, 10));
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(false);

      void queue.push(makeMsg({ text: 'new' }), 'thread1');
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

      void queue.push(makeMsg({ text: 'first' }), 'thread1');
      await new Promise((r) => setTimeout(r, 10));

      void queue.push(makeMsg({ text: 'buffered1' }), 'thread1');
      void queue.push(makeMsg({ text: 'buffered2' }), 'thread1');

      d1.resolve();
      await new Promise((r) => setTimeout(r, 10));

      expect(processed).toEqual(['first', 'buffered1\nbuffered2']);

      queue.dispose();
    });

    it('merges only messages to the same topic and keeps topicId and replyTo', async () => {
      const d1 = defer();
      const processed: ChannelMessage[] = [];
      let firstCall = true;
      const processor = vi.fn().mockImplementation(async (msg: ChannelMessage) => {
        processed.push(msg);
        if (firstCall) {
          firstCall = false;
          await d1.promise;
        }
      });
      const queue = new MessageQueue('collect', processor);

      void queue.push(makeMsg({ text: 'first', topicId: '7' }), 'thread1');
      await new Promise((r) => setTimeout(r, 10));
      void queue.push(makeMsg({ text: 'in 7', topicId: '7', replyTo: '41' }), 'thread1');
      void queue.push(makeMsg({ text: 'in 9', topicId: '9' }), 'thread1');
      void queue.push(makeMsg({ text: 'in 7 again', topicId: '7' }), 'thread1');
      d1.resolve();
      await new Promise((r) => setTimeout(r, 10));

      expect(processed.map((m) => [m.text, m.topicId, m.replyTo])).toEqual([
        ['first', '7', undefined],
        ['in 7\nin 7 again', '7', '41'],
        ['in 9', '9', undefined],
      ]);

      queue.dispose();
    });
  });

  describe('the promise of push', () => {
    it('settles in sequential mode once the message is processed, after those before it', async () => {
      const d1 = defer();
      const events: string[] = [];
      const queue = new MessageQueue('sequential', async (msg) => {
        events.push(`start:${msg.text}`);
        if (msg.text === 'first') await d1.promise;
        events.push(`end:${msg.text}`);
        if (msg.text === 'second') throw new Error('failed');
      });

      const settled = ['first', 'second', 'third'].map((text) =>
        queue.push(makeMsg({ text }), 'thread1').then(() => events.push(`settled:${text}`))
      );
      await new Promise((r) => setTimeout(r, 5));
      expect(events).toEqual(['start:first']);

      d1.resolve();
      await Promise.all(settled);
      const at = (event: string) => events.indexOf(event);
      expect(events.filter((e) => !e.startsWith('settled:'))).toEqual([
        'start:first',
        'end:first',
        'start:second',
        'end:second',
        'start:third',
        'end:third',
      ]);
      expect(events.filter((e) => e.startsWith('settled:'))).toEqual([
        'settled:first',
        'settled:second',
        'settled:third',
      ]);
      for (const text of ['first', 'second', 'third']) {
        expect(at(`settled:${text}`)).toBeGreaterThan(at(`end:${text}`));
      }
    });

    it('settles every message of a collected batch once the batch is processed', async () => {
      const d1 = defer();
      const processed: string[] = [];
      const queue = new MessageQueue('collect', async (msg) => {
        processed.push(msg.text);
        if (msg.text === 'first') await d1.promise;
      });

      const first = queue.push(makeMsg({ text: 'first' }), 'thread1');
      const batch = [
        queue.push(makeMsg({ text: 'a' }), 'thread1'),
        queue.push(makeMsg({ text: 'b' }), 'thread1'),
      ];
      d1.resolve();
      await Promise.all([first, ...batch]);

      expect(processed).toEqual(['first', 'a\nb']);
    });

    it('settles the messages dispose drops without processing them', async () => {
      const d1 = defer();
      const processor = vi.fn(async () => d1.promise);
      const queue = new MessageQueue('sequential', processor);

      const first = queue.push(makeMsg({ text: 'first' }), 'thread1');
      const dropped = queue.push(makeMsg({ text: 'dropped' }), 'thread1');
      queue.dispose();
      await dropped;
      d1.resolve();
      await first;

      expect(processor).toHaveBeenCalledTimes(1);
    });

    it('settles an interrupted message when the newer one takes over', async () => {
      const processor = vi.fn(
        (_msg: ChannelMessage, signal?: AbortSignal) =>
          new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
            setTimeout(resolve, 20);
          })
      );
      const queue = new MessageQueue('interrupt', processor);

      const old = queue.push(makeMsg({ text: 'old' }), 'thread1');
      const latest = queue.push(makeMsg({ text: 'new' }), 'thread1');
      await old;
      await latest;

      expect(processor).toHaveBeenCalledTimes(2);
    });
  });
});
