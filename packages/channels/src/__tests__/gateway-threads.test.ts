import { describe, it, expect, vi } from 'vitest';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type { Channel, ChannelMessage, GatewayConfig, RunOptions } from '@cogitator-ai/types';
import { Gateway } from '../gateway';
import type { GatewayFullConfig } from '../gateway';
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
      new Promise<{ output: string }>((resolve) => {
        const input = options.input;
        started.push(input);
        active++;
        maxActive = Math.max(maxActive, active);
        releases.set(input, () => {
          active--;
          resolve({ output: `re: ${input}` });
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

  it('fits session.threadKey', () => {
    const session: GatewayConfig['session'] = { threadKey: legacyThreadKey };
    expect(session.threadKey?.(message())).toBe('test:u1');
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

  it('drops the messages still waiting when it stops', async () => {
    const channel = createChannel();
    const control = controlledRun();
    const gateway = await startGateway(channel, control);

    await channel.trigger(message({ id: 'm1', text: 'first' }));
    await channel.trigger(message({ id: 'm2', text: 'second' }));
    await vi.waitFor(() => expect(control.started).toEqual(['first']));
    await gateway.stop();
    control.release('first');
    await gateway.idle();

    expect(control.started).toEqual(['first']);
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
