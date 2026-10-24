import { describe, it, expect, vi } from 'vitest';
import type {
  Channel,
  ChannelMessage,
  MemoryEntry,
  MessageRejectedEvent,
  RunOptions,
} from '@cogitator-ai/types';
import { MessageQueue, type MessageProcessing } from '../message-queue';
import { Gateway } from '../gateway';
import { createHookRegistry } from '../hooks';

function makeMsg(text: string, id = text): ChannelMessage {
  return { id, channelType: 'test', channelId: 'c1', userId: 'u1', text, raw: {} };
}

function defer<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A processor whose calls each wait for their own release, or for their signal to abort */
function heldProcessor() {
  const calls: { text: string; signal?: AbortSignal; processing?: MessageProcessing }[] = [];
  const started: ReturnType<typeof defer<void>>[] = [defer(), defer(), defer()];
  const releases: ReturnType<typeof defer<void>>[] = [defer(), defer(), defer()];
  const processor = vi.fn(
    async (msg: ChannelMessage, signal?: AbortSignal, processing?: MessageProcessing) => {
      const index = calls.length;
      calls.push({ text: msg.text, signal, processing });
      started[index].resolve();
      await new Promise<void>((resolve) => {
        void releases[index].promise.then(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return signal?.aborted !== true;
    }
  );
  return { processor, calls, started, releases };
}

describe('MessageQueue strategies', () => {
  it('enqueue answers one message after the other, as sequential does', async () => {
    const { processor, calls, started, releases } = heldProcessor();
    const queue = new MessageQueue('enqueue', processor);
    const first = queue.push(makeMsg('a'), 't');
    const second = queue.push(makeMsg('b'), 't');
    await started[0].promise;
    expect(calls.map((call) => call.text)).toEqual(['a']);
    releases[0].resolve();
    await started[1].promise;
    releases[1].resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls.map((call) => call.text)).toEqual(['a', 'b']);
  });

  it('reject refuses a message while its thread is busy, as not handled', async () => {
    const { processor, calls, started, releases } = heldProcessor();
    const rejected = vi.fn();
    const queue = new MessageQueue('reject', processor, rejected);
    const first = queue.push(makeMsg('a'), 't');
    await started[0].promise;

    expect(queue.refuses('t')).toBe(true);
    expect(await queue.push(makeMsg('b'), 't')).toBe(false);
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ text: 'b' }), 't');
    const other = queue.push(makeMsg('c'), 'u');
    await started[1].promise;
    releases[1].resolve();
    releases[0].resolve();
    await Promise.all([first, other]);
    expect(calls.map((call) => call.text)).toEqual(['a', 'c']);

    const later = queue.push(makeMsg('d'), 't');
    await started[2].promise;
    releases[2].resolve();
    expect(await later).toBe(true);
  });

  it('rollback stops the processing going on, waits for it, then names it in rollbackOf', async () => {
    const { processor, calls, started, releases } = heldProcessor();
    const queue = new MessageQueue('rollback', processor);
    const first = queue.push(makeMsg('a'), 't');
    await started[0].promise;

    const second = queue.push(makeMsg('b'), 't');
    expect(calls[0].signal?.aborted).toBe(true);
    expect(await first).toBe(false);
    await started[1].promise;
    expect(calls[1].processing?.rollbackOf).toBe(calls[0].signal);
    releases[1].resolve();
    expect(await second).toBe(true);
  });

  it('rollback skips a message stopped before it ran and rolls back to the run before it', async () => {
    const { processor, calls, started, releases } = heldProcessor();
    const queue = new MessageQueue('rollback', processor);
    const first = queue.push(makeMsg('a'), 't');
    await started[0].promise;
    const second = queue.push(makeMsg('b'), 't');
    const third = queue.push(makeMsg('c'), 't');

    expect(await first).toBe(false);
    expect(await second).toBe(false);
    await started[1].promise;
    expect(calls.map((call) => call.text)).toEqual(['a', 'c']);
    expect(calls[1].processing?.rollbackOf).toBe(calls[0].signal);
    releases[1].resolve();
    expect(await third).toBe(true);
  });

  it('rollback names nothing when the processing before it finished', async () => {
    const { processor, calls, started, releases } = heldProcessor();
    const queue = new MessageQueue('rollback', processor);
    const first = queue.push(makeMsg('a'), 't');
    await started[0].promise;
    releases[0].resolve();
    await first;
    const second = queue.push(makeMsg('b'), 't');
    await started[1].promise;
    expect(calls[1].processing?.rollbackOf).toBeUndefined();
    releases[1].resolve();
    await second;
  });
});

function createChannel() {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  const channel = {
    type: 'test',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((h: (msg: ChannelMessage) => Promise<void>) => {
      handler = h;
    }),
    sendText: vi.fn().mockResolvedValue('sent'),
    editText: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    trigger: (msg: ChannelMessage) => handler?.(msg) ?? Promise.resolve(),
  };
  return channel satisfies Channel & { trigger: unknown };
}

const agent = {
  id: 'a1',
  name: 'bot',
  model: 'ollama/test',
  instructions: '',
  tools: [],
  config: { name: 'bot', model: 'ollama/test', instructions: '' },
} as never;

function entry(parentId: string | null): MemoryEntry {
  return {
    id: 'e-new',
    threadId: 't',
    message: { role: 'user', content: 'hi' },
    tokenCount: 1,
    createdAt: new Date(0),
    parentId,
  };
}

describe('Gateway queue strategies', () => {
  it('rollback answers the new message on a branch from where the stopped run started', async () => {
    const channel = createChannel();
    const firstStarted = defer();
    const options: RunOptions[] = [];
    const run = vi.fn((_agent: unknown, opts: RunOptions) => {
      options.push(opts);
      if (options.length === 1) {
        opts.onMemoryEntry?.(entry('before-first'));
        firstStarted.resolve();
        return new Promise((_, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('stopped')), {
            once: true,
          });
        });
      }
      return Promise.resolve({ output: `answer to ${opts.input}` });
    });
    const onError = vi.fn();
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      queueMode: 'rollback',
      onError,
    });
    await gateway.start();
    await channel.trigger(makeMsg('first', 'm1'));
    await firstStarted.promise;
    await channel.trigger(makeMsg('second', 'm2'));
    await gateway.idle();

    expect(options[0].branch).toBeUndefined();
    expect(options.map((opts) => opts.multitaskStrategy)).toEqual(['rollback', 'rollback']);
    expect(options[1].branch).toEqual({ fromEntryId: 'before-first' });
    expect(onError).not.toHaveBeenCalled();
    expect(channel.sendText.mock.calls.map((call) => call[1])).toEqual(['answer to second']);
    await gateway.stop();
  });

  it('reject tells the message:rejected hook and runs nothing for the refused message', async () => {
    const channel = createChannel();
    const firstStarted = defer();
    const release = defer();
    const run = vi.fn(async (_agent: unknown, opts: RunOptions) => {
      firstStarted.resolve();
      await release.promise;
      return { output: `answer to ${opts.input}` };
    });
    const hooks = createHookRegistry();
    const rejected: MessageRejectedEvent[] = [];
    hooks.on('message:rejected', (event) => {
      rejected.push(event);
    });
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      queueMode: 'reject',
      hooks,
    });
    await gateway.start();
    await channel.trigger(makeMsg('first', 'm1'));
    await firstStarted.promise;
    await channel.trigger(makeMsg('second', 'm2'));
    release.resolve();
    await gateway.idle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1].multitaskStrategy).toBe('reject');
    expect(rejected).toEqual([
      expect.objectContaining({ reason: 'busy', msg: expect.objectContaining({ text: 'second' }) }),
    ]);
    await gateway.stop();
  });

  it('reject makes injectMessage fail for the refused message, and never hands it back', async () => {
    const channel = { ...createChannel(), redeliver: vi.fn().mockResolvedValue(undefined) };
    const firstStarted = defer();
    const release = defer();
    const run = vi.fn(async (_agent: unknown, opts: RunOptions) => {
      firstStarted.resolve();
      await release.promise;
      return { output: `answer to ${opts.input}` };
    });
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      queueMode: 'reject',
    });
    await gateway.start();
    await channel.trigger(makeMsg('first', 'm1'));
    await firstStarted.promise;
    await expect(gateway.injectMessage(makeMsg('second', 'm2'))).rejects.toThrow(/refused/);
    await channel.trigger(makeMsg('third', 'm3'));
    release.resolve();
    await gateway.idle();
    await gateway.stop();
    expect(channel.redeliver).not.toHaveBeenCalled();
  });

  it('runs a sequential queue as enqueue and an interrupt queue as interrupt', async () => {
    for (const [queueMode, strategy] of [
      ['sequential', 'enqueue'],
      ['interrupt', 'interrupt'],
      ['parallel', undefined],
    ] as const) {
      const channel = createChannel();
      const run = vi.fn(async (_agent: unknown, opts: RunOptions) => ({ output: opts.input }));
      const gateway = new Gateway({
        agent,
        channels: [channel],
        cogitator: { run } as never,
        queueMode,
      });
      await gateway.start();
      await channel.trigger(makeMsg('hi', `m-${queueMode}`));
      await gateway.idle();
      expect(run.mock.calls[0]?.[1].multitaskStrategy).toBe(strategy);
      await gateway.stop();
    }
  });
});
