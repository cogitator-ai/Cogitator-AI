import { describe, it, expect, vi } from 'vitest';
import { AsyncQueue } from '../async-queue';

describe('AsyncQueue', () => {
  it('keeps values pushed while nobody reads, in order', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();
    const values: number[] = [];
    for await (const value of queue) values.push(value);
    expect(values).toEqual([1, 2]);
  });

  it('hands a value to a reader that waits for it', async () => {
    const queue = new AsyncQueue<string>();
    const next = queue.next();
    queue.push('a');
    await expect(next).resolves.toEqual({ done: false, value: 'a' });
  });

  it('fails after the values queued before the failure are read', async () => {
    const queue = new AsyncQueue<string>();
    queue.push('a');
    queue.fail(new Error('broken'));
    queue.push('ignored');
    await expect(queue.next()).resolves.toEqual({ done: false, value: 'a' });
    await expect(queue.next()).rejects.toThrow('broken');
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('rejects a waiting reader on failure', async () => {
    const queue = new AsyncQueue<string>();
    const next = queue.next();
    queue.fail(new Error('broken'));
    await expect(next).rejects.toThrow('broken');
  });

  it('drops queued values and calls onReturn once when the reader stops early', async () => {
    const onReturn = vi.fn();
    const queue = new AsyncQueue<string>(onReturn);
    queue.push('a');
    const waiting = new AsyncQueue<string>(onReturn);
    const pending = waiting.next();

    await queue.return();
    await queue.return();
    await waiting.return();

    expect(onReturn).toHaveBeenCalledTimes(2);
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('does not call onReturn after the queue ended', async () => {
    const onReturn = vi.fn();
    const queue = new AsyncQueue<string>(onReturn);
    queue.end();
    await queue.return();
    expect(onReturn).not.toHaveBeenCalled();
  });
});
