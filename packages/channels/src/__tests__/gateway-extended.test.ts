import { describe, it, expect, vi } from 'vitest';
import { Gateway } from '../gateway';
import { createHookRegistry } from '../hooks';
import type {
  Channel,
  ChannelMessage,
  MemoryAdapter,
  SessionManager,
  RunOptions,
} from '@cogitator-ai/types';

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
    setReaction: vi.fn().mockResolvedValue(undefined),
    trigger: (msg: ChannelMessage) => handler?.(msg) ?? Promise.resolve(),
  };
  return channel satisfies Channel & { trigger: unknown };
}

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'm1',
    channelType: 'test',
    channelId: 'c1',
    userId: 'u1',
    text: 'hi',
    raw: {},
    ...overrides,
  };
}

const agent = {
  id: 'a1',
  name: 'bot',
  model: 'ollama/test',
  instructions: '',
  tools: [],
  config: { name: 'bot', model: 'ollama/test', instructions: '' },
} as never;

describe('Gateway regressions', () => {
  it('uses a provided sessionManager and emits session:created once', async () => {
    const channel = createChannel();
    let count = 0;
    const sessionManager = {
      getOrCreate: vi.fn().mockImplementation(async () => ({ id: 's1', messageCount: count++ })),
      incrementMessageCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;
    const hooks = createHookRegistry();
    const created = vi.fn();
    hooks.on('session:created', created);

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run: vi.fn().mockResolvedValue({ output: 'ok' }) } as never,
      sessionManager,
      hooks,
    });
    await gateway.start();
    await channel.trigger(msg());
    await channel.trigger(msg({ id: 'm2' }));

    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('compacts the conversation thread with an LLM summary', async () => {
    const channel = createChannel();
    const entries = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      threadId: 'test:u1',
      message: { role: 'user', content: `message number ${i} `.repeat(20) },
      createdAt: new Date(2026, 0, 1, 0, i),
      tokenCount: 100,
    }));
    const memory = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: null }),
      createThread: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'session_test_u1',
          agentId: 'bot',
          metadata: { _session: true },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      updateThread: vi.fn().mockResolvedValue({ success: true }),
      getEntries: vi.fn().mockResolvedValue({ success: true, data: entries }),
      addEntry: vi.fn(async (entry: { createdAt?: Date }) => ({
        success: true,
        data: { ...entry, id: 'summary', createdAt: entry.createdAt ?? new Date() },
      })),
      deleteEntry: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as MemoryAdapter;
    const chat = vi.fn().mockResolvedValue({ content: 'SUMMARY' });
    const hooks = createHookRegistry();
    const compacted = vi.fn();
    hooks.on('session:compacted', compacted);

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: {
        run: vi.fn().mockResolvedValue({ output: 'ok' }),
        getLLMBackend: vi.fn().mockReturnValue({ chat }),
        resolveModel: (a: { model?: string }) => a.model,
      } as never,
      memory,
      hooks,
      session: { compaction: { strategy: 'summary', threshold: 6, keepRecent: 2 } },
    });
    await gateway.start();
    await channel.trigger(msg());

    expect(memory.getEntries).toHaveBeenCalledWith({ threadId: 'test:u1', includeToolCalls: true });
    expect(memory.getEntries).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'test' }));
    expect(memory.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'test:u1',
        message: expect.objectContaining({ content: expect.stringContaining('SUMMARY') }),
      })
    );
    const added = vi.mocked(memory.addEntry).mock.calls.map(([entry]) => entry);
    expect(added).toHaveLength(1);
    expect(added[0].createdAt).toEqual(new Date(entries[4].createdAt.getTime() - 1));
    const deletedIds = vi.mocked(memory.deleteEntry).mock.calls.map(([id]) => id);
    expect(deletedIds).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(compacted).toHaveBeenCalled();
  });

  it('does not compact below the message threshold', async () => {
    const channel = createChannel();
    const memory = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: null }),
      createThread: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 's',
          agentId: 'bot',
          metadata: { _session: true },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      updateThread: vi.fn().mockResolvedValue({ success: true }),
      getEntries: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: 'e',
            threadId: 'test:u1',
            message: { role: 'user', content: 'x'.repeat(5000) },
            createdAt: new Date(),
          },
        ],
      }),
      addEntry: vi.fn(),
      deleteEntry: vi.fn(),
    } as unknown as MemoryAdapter;
    const getLLMBackend = vi.fn();

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: {
        run: vi.fn().mockResolvedValue({ output: 'ok' }),
        getLLMBackend,
        resolveModel: (a: { model?: string }) => a.model,
      } as never,
      memory,
      session: { compaction: { strategy: 'summary', threshold: 50, keepRecent: 10 } },
    });
    await gateway.start();
    await channel.trigger(msg());

    expect(memory.getEntries).toHaveBeenCalledTimes(1);
    expect(getLLMBackend).not.toHaveBeenCalled();
    expect(memory.deleteEntry).not.toHaveBeenCalled();
  });

  it('counts the compaction threshold in tokens, as CompactionService does', async () => {
    const channel = createChannel();
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      threadId: 'test:u1',
      message: { role: 'user', content: `short message number ${i}` },
      createdAt: new Date(2026, 0, 1, 0, i),
      tokenCount: 10,
    }));
    const memory = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: null }),
      createThread: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 's',
          agentId: 'bot',
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      updateThread: vi.fn().mockResolvedValue({ success: true }),
      getEntries: vi.fn().mockResolvedValue({ success: true, data: entries }),
      addEntry: vi.fn(async (entry: { createdAt?: Date }) => ({
        success: true,
        data: { ...entry, id: 'summary', createdAt: entry.createdAt ?? new Date() },
      })),
      deleteEntry: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as MemoryAdapter;
    const chat = vi.fn().mockResolvedValue({ content: 'SUMMARY' });

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: {
        run: vi.fn().mockResolvedValue({ output: 'ok' }),
        getLLMBackend: vi.fn().mockReturnValue({ chat }),
        resolveModel: (a: { model?: string }) => a.model,
      } as never,
      memory,
      session: { compaction: { strategy: 'summary', threshold: 100, keepRecent: 2 } },
    });
    await gateway.start();
    await channel.trigger(msg());

    expect(chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(memory.deleteEntry)).toHaveBeenCalledTimes(10);
  });

  it('compacts by message count with messageThreshold', async () => {
    const channel = createChannel();
    const entries = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      threadId: 'test:u1',
      message: { role: 'user', content: `m${i}` },
      createdAt: new Date(2026, 0, 1, 0, i),
      tokenCount: 1,
    }));
    const memory = {
      getThread: vi.fn().mockResolvedValue({ success: true, data: null }),
      createThread: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 's',
          agentId: 'bot',
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      updateThread: vi.fn().mockResolvedValue({ success: true }),
      getEntries: vi.fn().mockResolvedValue({ success: true, data: entries }),
      addEntry: vi.fn(async (entry: { createdAt?: Date }) => ({
        success: true,
        data: { ...entry, id: 'summary', createdAt: entry.createdAt ?? new Date() },
      })),
      deleteEntry: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as MemoryAdapter;
    const chat = vi.fn().mockResolvedValue({ content: 'SUMMARY' });

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: {
        run: vi.fn().mockResolvedValue({ output: 'ok' }),
        getLLMBackend: vi.fn().mockReturnValue({ chat }),
        resolveModel: (a: { model?: string }) => a.model,
      } as never,
      memory,
      session: { compaction: { strategy: 'summary', messageThreshold: 5, keepRecent: 2 } },
    });
    await gateway.start();
    await channel.trigger(msg());

    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('routes debounced messages through the queue', async () => {
    const channel = createChannel();
    let active = 0;
    let maxActive = 0;
    const run = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { output: 'ok' };
    });

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      debounce: { enabled: true, delayMs: 5 },
      queueMode: 'sequential',
    });
    await gateway.start();
    await channel.trigger(msg({ text: 'a' }));
    await new Promise((r) => setTimeout(r, 15));
    await channel.trigger(msg({ text: 'b' }));

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2), { timeout: 500 });
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maxActive).toBe(1);
  });

  it('interrupt mode aborts the previous run without reporting an error', async () => {
    const channel = createChannel();
    const onError = vi.fn();
    const signals: AbortSignal[] = [];
    const run = vi.fn().mockImplementation(
      (_agent: unknown, opts: RunOptions) =>
        new Promise((resolve, reject) => {
          if (opts.signal) signals.push(opts.signal);
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => resolve({ output: opts.input }), 40);
        })
    );

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      queueMode: 'interrupt',
      onError,
    });
    await gateway.start();
    await channel.trigger(msg({ text: 'first' }));
    await new Promise((r) => setTimeout(r, 5));
    await channel.trigger(msg({ id: 'm2', text: 'second' }));

    await vi.waitFor(() => expect(channel.sendText).toHaveBeenCalled());
    expect(signals[0].aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(channel.sendText.mock.calls[0][1]).toBe('second');
  });

  it('passes runTimeout and wires tool reactions', async () => {
    const channel = createChannel();
    const run = vi.fn().mockImplementation(async (_a: unknown, opts: RunOptions) => {
      opts.onToolCall?.({ id: 't', name: 'calc', arguments: {} });
      await new Promise((r) => setTimeout(r, 30));
      return { output: 'ok' };
    });

    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      runTimeout: 5000,
      reactions: { enabled: true, debounceMs: 1 },
    });
    await gateway.start();
    await channel.trigger(msg());

    expect(run.mock.calls[0][1]).toEqual(expect.objectContaining({ timeout: 5000 }));
    const emojis = channel.setReaction.mock.calls.map((c) => c[2]);
    expect(emojis).toContain('\u{1F525}');
  });

  it('rolls back when a channel fails to start', async () => {
    const ok = createChannel('a');
    const broken = createChannel('b');
    broken.start.mockRejectedValue(new Error('bad token'));

    const gateway = new Gateway({
      agent,
      channels: [ok, broken],
      cogitator: { run: vi.fn() } as never,
    });

    await expect(gateway.start()).rejects.toThrow('bad token');
    expect(ok.stop).toHaveBeenCalled();
    expect(gateway.stats.uptime).toBe(0);
  });

  it('tracks sessions in stats and getSessions()', async () => {
    const channel = createChannel();
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run: vi.fn().mockResolvedValue({ output: 'ok' }) } as never,
    });
    await gateway.start();
    await channel.trigger(msg({ userName: 'Ann' }));
    await channel.trigger(msg({ userId: 'u2' }));
    await channel.trigger(msg());

    expect(gateway.stats.totalSessions).toBe(2);
    expect(gateway.stats.activeSessions).toBe(0);
    const sessions = gateway.getSessions();
    const ann = sessions.find((s) => s.threadId === 'test:u1');
    expect(ann).toEqual(
      expect.objectContaining({ userName: 'Ann', messageCount: 2, active: false })
    );
  });

  it('does not reply to scheduled messages and skips empty output', async () => {
    const channel = createChannel();
    const run = vi
      .fn()
      .mockResolvedValueOnce({ output: 'reminder' })
      .mockResolvedValueOnce({ output: '' });
    const gateway = new Gateway({ agent, channels: [channel], cogitator: { run } as never });
    await gateway.start();

    await channel.trigger(msg({ raw: { scheduled: true } }));
    await channel.trigger(msg());

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(channel.sendText.mock.calls[0][2]).not.toHaveProperty('replyTo');
  });

  it('streams tokens and finishes with the full text', async () => {
    const channel = createChannel();
    const run = vi.fn().mockImplementation(async (_a: unknown, opts: RunOptions) => {
      for (const t of ['Hel', 'lo ', 'there']) opts.onToken?.(t);
      return { output: 'Hello there' };
    });
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      stream: { flushInterval: 10_000, minChunkSize: 1 },
    });
    await gateway.start();
    await channel.trigger(msg());

    expect(channel.sendText).toHaveBeenCalledTimes(1);
    expect(channel.sendText.mock.calls[0][1]).toBe('Hello there');
  });
});

describe('Gateway streaming formatting', () => {
  it('adapts markdown for the platform while streaming', async () => {
    const channel = createChannel('telegram');
    const run = vi.fn().mockImplementation(async (_a: unknown, opts: RunOptions) => {
      opts.onToken?.('# Title\n**bold**');
      return { output: '# Title\n**bold**' };
    });
    const gateway = new Gateway({
      agent,
      channels: [channel],
      cogitator: { run } as never,
      stream: { flushInterval: 10_000, minChunkSize: 1 },
    });
    await gateway.start();
    await channel.trigger(msg({ channelType: 'telegram' }));

    expect(channel.sendText.mock.calls[0][1]).toBe('*Title*\n*bold*');
  });
});
