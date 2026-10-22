import { describe, it, expect, vi } from 'vitest';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type { Channel, ChannelMessage, RunOptions } from '@cogitator-ai/types';
import { Gateway } from '../gateway';
import type { GatewayFullConfig } from '../gateway';
import { createSchedulerTools } from '@cogitator-ai/core';
import { HeartbeatScheduler } from '../heartbeat';
import { SimpleTimerStore } from '../simple-timer-store';
import { defaultThreadKey, legacyThreadKey, readConversations } from '../thread-key';

const agent = { name: 'bot', id: 'a1', instructions: 'hi', tools: [], config: {} } as never;

function createChannel(type = 'test') {
  let handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  const channel = {
    type,
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

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'm1',
    channelType: 'test',
    channelId: 'chat',
    userId: 'u1',
    text: 'hi',
    raw: {},
    ...overrides,
  };
}

/** A `cogitator.run` whose runs finish only when the test releases them, in any order */
function controlledRun() {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;
  const run = vi.fn(
    (_agent: unknown, options: RunOptions) =>
      new Promise<{ output: string }>((resolve, reject) => {
        const input = options.input;
        started.push(input);
        active++;
        maxActive = Math.max(maxActive, active);
        releases.set(input, () => {
          active--;
          resolve({ output: `re: ${input}` });
        });
        options.signal?.addEventListener('abort', () => {
          active--;
          reject(new Error('aborted'));
        });
      })
  );
  return {
    run,
    started,
    maxActive: () => maxActive,
    release: (input: string) => releases.get(input)?.(),
  };
}

function threadIds(run: ReturnType<typeof vi.fn>): unknown[] {
  return run.mock.calls.map(([, options]) => (options as RunOptions).threadId);
}

async function startGateway(
  channel: ReturnType<typeof createChannel>,
  cogitator: { run: ReturnType<typeof vi.fn> },
  overrides: Partial<GatewayFullConfig> = {}
): Promise<Gateway> {
  const gateway = new Gateway({
    agent,
    channels: [channel],
    cogitator: cogitator as never,
    ...overrides,
  });
  await gateway.start();
  return gateway;
}

describe('thread keys', () => {
  it('keys a thread by channel type, conversation and user', () => {
    expect(defaultThreadKey(message())).toBe('test:chat:u1');
    expect(defaultThreadKey(message({ topicId: '7' }))).toBe('test:chat:7:u1');
    expect(
      defaultThreadKey(
        message({ channelId: 'post:x', conversationId: 'thread:root', topicId: '7' })
      )
    ).toBe('test:thread:root:u1');
    expect(legacyThreadKey(message({ topicId: '7' }))).toBe('test:u1');
  });
});

describe('Gateway thread order', () => {
  it('answers the messages of one thread one at a time, in the order they came', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const gateway = await startGateway(channel, control);

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await channel.trigger(message({ id: 'm2', text: 'second' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first']));
    expect(gateway.stats.activeSessions).toBe(1);

    control.release('first');
    await vi.waitFor(() => expect(control.started).toEqual(['first', 'second']));
    control.release('second');
    await gateway.idle();

    expect(control.maxActive()).toBe(1);
    expect(channel.sendText.mock.calls.map((call) => call[1])).toEqual(['re: first', 're: second']);
    expect(gateway.stats.activeSessions).toBe(0);
  });

  it('runs different threads side by side', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const gateway = await startGateway(channel, control);

    await channel.trigger(message({ id: 'm1', text: 'from u1' }));
    await channel.trigger(message({ id: 'm2', userId: 'u2', text: 'from u2' }));
    await channel.trigger(message({ id: 'm3', channelId: 'other', text: 'u1 elsewhere' }));
    await vi.waitFor(() => expect(control.started).toHaveLength(3));
    expect(gateway.stats.activeSessions).toBe(3);

    for (const input of ['from u1', 'from u2', 'u1 elsewhere']) control.release(input);
    await gateway.idle();

    expect(control.maxActive()).toBe(3);
    expect(threadIds(control.run)).toEqual(['test:chat:u1', 'test:chat:u2', 'test:other:u1']);
  });

  it('runs every message at once with queueMode parallel', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const gateway = await startGateway(channel, control, { queueMode: 'parallel' });

    void channel.trigger(message({ id: 'm1', text: 'first' }));
    void channel.trigger(message({ id: 'm2', text: 'second' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first', 'second']));

    control.release('second');
    control.release('first');
    await gateway.idle();

    expect(control.maxActive()).toBe(2);
  });

  it('resolves injectMessage once the message is answered', async () => {
    const channel = createChannel();
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'done' }) };
    const gateway = await startGateway(channel, cogitator);

    await gateway.injectMessage(message());

    expect(channel.sendText).toHaveBeenCalledWith('chat', 'done', expect.anything());
  });

  it('answers what it was given before it stops the channels', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const gateway = await startGateway(channel, control);

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await channel.trigger(message({ id: 'm2', text: 'second' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first']));
    const stopped = gateway.stop();
    control.release('first');
    await vi.waitFor(() => expect(control.started).toEqual(['first', 'second']));
    expect(channel.stop).not.toHaveBeenCalled();
    control.release('second');
    await stopped;

    expect(channel.sendText.mock.calls.map((call) => call[1])).toEqual(['re: first', 're: second']);
    expect(channel.stop).toHaveBeenCalledTimes(1);
  });

  it('aborts the runs and drops the waiting messages past drainTimeout', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const onError = vi.fn();
    const gateway = await startGateway(channel, control, { drainTimeout: 20, onError });

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await channel.trigger(message({ id: 'm2', text: 'second' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first']));
    await gateway.stop();

    const signal = control.run.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(true);
    expect(control.started).toEqual(['first']);
    expect(channel.sendText).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(channel.stop).toHaveBeenCalledTimes(1);
    expect(gateway.stats.activeSessions).toBe(0);
  });

  it('refuses messages that come in while it stops, and returns the same stop twice', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const onError = vi.fn();
    const gateway = await startGateway(channel, control, { onError });

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first']));
    const stopped = gateway.stop();
    expect(gateway.stop()).toBe(stopped);
    await channel.trigger(message({ id: 'm2', text: 'late', userId: 'u2' }));
    await expect(gateway.injectMessage(message({ id: 'm3', text: 'later' }))).rejects.toThrow(
      'The gateway is stopping'
    );
    control.release('first');
    await stopped;

    expect(control.started).toEqual(['first']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map(([, msg]) => (msg as ChannelMessage).id)).toEqual(['m2', 'm3']);
    expect(channel.sendText).toHaveBeenCalledTimes(1);
  });

  it('hands a message that came in while it stops back to a channel that redelivers', async () => {
    const channel = { ...createChannel(), redeliver: vi.fn().mockResolvedValue(undefined) };
    const control = controlledRun();
    const gateway = await startGateway(channel, control, { onError: vi.fn() });

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first']));
    const stopped = gateway.stop();
    await channel.trigger(message({ id: 'm2', text: 'late', userId: 'u2' }));
    expect(channel.redeliver.mock.calls.map(([msg]) => (msg as ChannelMessage).id)).toEqual(['m2']);
    control.release('first');
    await stopped;
    expect(channel.redeliver).toHaveBeenCalledTimes(1);
  });

  it('hands the messages it drops unanswered at stop back to a channel that redelivers', async () => {
    const channel = { ...createChannel(), redeliver: vi.fn().mockResolvedValue(undefined) };
    const control = controlledRun();
    const gateway = await startGateway(channel, control, { drainTimeout: 20 });

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await channel.trigger(message({ id: 'm2', text: 'second' }));
    await channel.trigger(message({ id: 'm3', text: 'done', userId: 'u3' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first', 'done']));
    control.release('done');
    await vi.waitFor(() => expect(channel.sendText).toHaveBeenCalledTimes(1));
    await gateway.stop();

    expect(channel.redeliver.mock.calls.map(([msg]) => (msg as ChannelMessage).id).sort()).toEqual([
      'm1',
      'm2',
    ]);
    expect(channel.redeliver.mock.invocationCallOrder[1]).toBeLessThan(
      channel.stop.mock.invocationCallOrder[0]
    );
  });

  it('does not hand back a message whose run failed while it was running', async () => {
    const channel = { ...createChannel(), redeliver: vi.fn().mockResolvedValue(undefined) };
    const run = vi.fn().mockRejectedValue(new Error('model down'));
    const gateway = await startGateway(channel, { run }, { onError: vi.fn() });

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await gateway.idle();
    await gateway.stop();

    expect(channel.redeliver).not.toHaveBeenCalled();
  });

  it('refuses a debounced message that comes in while it stops, and answers nothing after', async () => {
    vi.useFakeTimers();
    try {
      const channel = createChannel();
      let release = () => {};
      let markStarted = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = vi.fn(
        () =>
          new Promise<{ output: string }>((resolve) => {
            release = () => resolve({ output: 'ok' });
            markStarted();
          })
      );
      const gateway = await startGateway(
        channel,
        { run },
        {
          debounce: { enabled: true, delayMs: 1000 },
        }
      );

      await channel.trigger(message({ id: 'm1', text: 'first' }));
      const stopped = gateway.stop();
      await started;
      await channel.trigger(message({ id: 'm2', text: 'late' }));
      release();
      await stopped;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(run).toHaveBeenCalledTimes(1);
      expect(gateway.stats.activeSessions).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects injectMessage when stop aborts its run, so the scheduler keeps the task', async () => {
    const store = new SimpleTimerStore();
    await store.schedule({
      workflowId: 'heartbeat',
      runId: 'scheduler',
      nodeId: 'task',
      firesAt: Date.now() - 1000,
      type: 'fixed',
      metadata: { description: 'Stretch', channel: 'test', channelId: 'chat', userId: 'u1' },
    });
    const channel = createChannel();
    const control = controlledRun();
    const gateway = await startGateway(channel, control, { drainTimeout: 20 });
    const scheduler = new HeartbeatScheduler(store, {
      onFire: (msg) => gateway.injectMessage(msg),
      pollInterval: 10,
    });

    scheduler.start();
    await vi.waitFor(() => expect(control.started).toHaveLength(1));
    scheduler.stop();
    await gateway.stop();
    await vi.waitFor(async () => {
      const [task] = await store.list();
      expect(task?.lastRunStatus).toBe('error');
    });

    expect(await store.getOverdue()).toHaveLength(1);
  });

  it('answers messages held by debounce before it stops', async () => {
    const channel = createChannel();
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const gateway = await startGateway(channel, cogitator, {
      debounce: { enabled: true, delayMs: 60_000 },
    });

    await channel.trigger(message({ text: 'one' }));
    await channel.trigger(message({ id: 'm2', text: 'two' }));
    await gateway.stop();

    expect(cogitator.run).toHaveBeenCalledTimes(1);
    expect(cogitator.run.mock.calls[0]?.[1]).toMatchObject({ input: 'one\ntwo' });
    expect(channel.sendText).toHaveBeenCalledTimes(1);
  });
});

describe('Gateway conversations', () => {
  it('keeps Telegram forum topics apart and answers each in its topic', async () => {
    const channel = createChannel('telegram');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const gateway = await startGateway(channel, cogitator);
    const topic = (topicId: string, id: string) =>
      message({ id, channelType: 'telegram', channelId: '-100', groupId: '-100', topicId });

    await channel.trigger(topic('7', 'm1'));
    await channel.trigger(topic('9', 'm2'));
    await gateway.idle();

    expect(threadIds(cogitator.run)).toEqual(['telegram:-100:7:u1', 'telegram:-100:9:u1']);
    expect(channel.sendText.mock.calls.map((call) => call[2]?.topicId)).toEqual(['7', '9']);
  });

  it('keeps Slack threads of a channel apart', async () => {
    const channel = createChannel('slack');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const gateway = await startGateway(channel, cogitator);
    const slack = (overrides: Partial<ChannelMessage>) =>
      message({ channelType: 'slack', channelId: 'C1', ...overrides });

    await channel.trigger(slack({ id: '100.1', topicId: '100.1' }));
    await channel.trigger(slack({ id: '100.2', topicId: '100.1', replyTo: '100.1' }));
    await channel.trigger(slack({ id: '200.1', topicId: '200.1' }));
    await gateway.idle();

    expect(threadIds(cogitator.run).sort()).toEqual([
      'slack:C1:100.1:u1',
      'slack:C1:100.1:u1',
      'slack:C1:200.1:u1',
    ]);
  });

  it.each(['bluesky', 'threads'])(
    'keeps the replies of a %s thread in one thread while answering each post',
    async (channelType) => {
      const channel = createChannel(channelType);
      const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
      const gateway = await startGateway(channel, cogitator);
      const post = (id: string) =>
        message({
          id,
          channelType,
          channelId: `post:${id}`,
          groupId: 'thread:root',
          conversationId: 'thread:root',
        });

      await channel.trigger(post('p1'));
      await channel.trigger(post('p2'));
      await gateway.idle();

      expect(threadIds(cogitator.run)).toEqual([
        `${channelType}:thread:root:u1`,
        `${channelType}:thread:root:u1`,
      ]);
      expect(channel.sendText.mock.calls.map((call) => call[0])).toEqual(['post:p1', 'post:p2']);
    }
  );

  it('keeps the old threads with legacyThreadKey', async () => {
    const channel = createChannel('telegram');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const gateway = await startGateway(channel, cogitator, {
      session: { threadKey: legacyThreadKey },
    });

    await channel.trigger(message({ channelType: 'telegram', channelId: '-100', topicId: '7' }));
    await channel.trigger(message({ id: 'm2', channelType: 'telegram', channelId: 'u1' }));
    await gateway.idle();

    expect(threadIds(cogitator.run)).toEqual(['telegram:u1', 'telegram:u1']);
  });

  it('keeps the conversations of a user in their session, most recent first', async () => {
    const memory = new InMemoryAdapter();
    const channel = createChannel('telegram');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const sessionWrites = vi.spyOn(memory, 'updateThread');
    const gateway = await startGateway(channel, cogitator, { memory });
    const send = async (overrides: Partial<ChannelMessage>) => {
      await channel.trigger(message({ channelType: 'telegram', ...overrides }));
      await gateway.idle();
    };

    await send({ id: 'm1', channelId: '-100', topicId: '7' });
    await send({ id: 'm2', channelId: 'u1' });
    await send({ id: 'm3', channelId: '-100', topicId: '7' });
    const writes = sessionWrites.mock.calls.length;
    await send({ id: 'm4', channelId: '-100', topicId: '7' });

    const thread = await memory.getThread('session_telegram_u1');
    const metadata = thread.success ? thread.data?.metadata : undefined;
    expect(readConversations(metadata)).toEqual([
      { channelId: '-100', topicId: '7' },
      { channelId: 'u1' },
    ]);
    expect(sessionWrites.mock.calls.length - writes).toBe(1);
  });

  it('answers a scheduled task in the topic of the conversation it was set in', async () => {
    const memory = new InMemoryAdapter();
    const channel = createChannel('telegram');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const gateway = await startGateway(channel, cogitator, { memory });

    await channel.trigger(message({ channelType: 'telegram', channelId: '-100', topicId: '7' }));
    await gateway.idle();
    await gateway.injectMessage(
      message({
        id: 'heartbeat_1',
        channelType: 'telegram',
        channelId: '-100',
        text: '[SCHEDULED TASK] remind',
        raw: { scheduled: true, taskId: '1' },
      })
    );

    expect(threadIds(cogitator.run)).toEqual(['telegram:-100:7:u1', 'telegram:-100:7:u1']);
    expect(channel.sendText.mock.calls[1]).toEqual([
      '-100',
      'ok',
      expect.objectContaining({ topicId: '7' }),
    ]);
  });

  it('fires a reminder in the topic it was set in, though the user moved to another', async () => {
    const memory = new InMemoryAdapter();
    const store = new SimpleTimerStore();
    const [scheduleTask] = createSchedulerTools({ store });
    const channel = createChannel('telegram');
    const run = vi.fn(async (_agent: unknown, options: RunOptions) => {
      if (options.input === 'remind me') {
        await scheduleTask.execute(
          { description: 'Stretch', at: new Date(Date.now() - 1000).toISOString() },
          {
            agentId: 'bot',
            runId: 'r1',
            signal: new AbortController().signal,
            channelType: options.channelType,
            channelId: options.channelId,
            topicId: options.topicId,
            conversationId: options.conversationId,
            userId: options.userId,
          }
        );
      }
      return { output: 'ok' };
    });
    const gateway = await startGateway(channel, { run }, { memory });
    const inTopic = (topicId: string, id: string, text: string) =>
      message({ id, channelType: 'telegram', channelId: '-100', topicId, text });

    await channel.trigger(inTopic('7', 'm1', 'remind me'));
    await gateway.idle();
    await channel.trigger(inTopic('9', 'm2', 'something else'));
    await gateway.idle();

    const fired: ChannelMessage[] = [];
    const scheduler = new HeartbeatScheduler(store, {
      onFire: async (msg) => {
        fired.push(msg);
        await gateway.injectMessage(msg);
      },
      pollInterval: 10,
    });
    scheduler.start();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3));
    scheduler.stop();
    await gateway.idle();

    expect(fired[0]).toMatchObject({ channelId: '-100', topicId: '7' });
    expect(threadIds(run)).toEqual([
      'telegram:-100:7:u1',
      'telegram:-100:9:u1',
      'telegram:-100:7:u1',
    ]);
    expect(channel.sendText.mock.calls[2]?.[2]).toMatchObject({ topicId: '7' });
  });

  it('fires a Bluesky reminder in the post thread it was set in', async () => {
    const memory = new InMemoryAdapter();
    const channel = createChannel('bluesky');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const gateway = await startGateway(channel, cogitator, { memory });

    await gateway.injectMessage(
      message({
        id: 'heartbeat_1',
        channelType: 'bluesky',
        channelId: 'post:p1',
        conversationId: 'thread:root',
        raw: { scheduled: true, taskId: '1' },
      })
    );

    expect(threadIds(cogitator.run)).toEqual(['bluesky:thread:root:u1']);
    expect(cogitator.run.mock.calls[0]?.[1]).toMatchObject({ conversationId: 'thread:root' });
  });

  it('leaves a scheduled task as it is when threads are keyed by session.threadKey', async () => {
    const memory = new InMemoryAdapter();
    const channel = createChannel('telegram');
    const cogitator = { run: vi.fn().mockResolvedValue({ output: 'ok' }) };
    const threadKey = vi.fn((msg: ChannelMessage) => `custom:${msg.topicId ?? '-'}`);
    const gateway = await startGateway(channel, cogitator, { memory, session: { threadKey } });

    await channel.trigger(message({ channelType: 'telegram', channelId: '-100', topicId: '7' }));
    await gateway.idle();
    await gateway.injectMessage(
      message({
        id: 'heartbeat_1',
        channelType: 'telegram',
        channelId: '-100',
        raw: { scheduled: true, taskId: '1' },
      })
    );

    expect(threadIds(cogitator.run)).toEqual(['custom:7', 'custom:-']);
  });
});
