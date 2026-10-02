import { describe, it, expect, vi } from 'vitest';
import { MessageQueue } from '../message-queue';
import type { ChannelMessage } from '@cogitator-ai/types';

const msg = (text: string): ChannelMessage => ({
  id: text,
  channelType: 't',
  channelId: 'c',
  userId: 'u',
  text,
  raw: {},
});

function threadCount(queue: MessageQueue): number {
  return (queue as unknown as { threads: Map<string, unknown> }).threads.size;
}

describe('MessageQueue thread lifecycle', () => {
  it.each(['sequential', 'collect', 'interrupt'] as const)(
    'releases idle threads in %s mode',
    async (mode) => {
      const processor = vi.fn().mockResolvedValue(undefined);
      const queue = new MessageQueue(mode, processor);

      queue.push(msg('a'), 't1');
      queue.push(msg('b'), 't2');
      await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(threadCount(queue)).toBe(0));
    }
  );

  it('does not raise unhandled rejections in parallel mode', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const queue = new MessageQueue('parallel', vi.fn().mockRejectedValue(new Error('x')));
      queue.push(msg('a'), 't');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
