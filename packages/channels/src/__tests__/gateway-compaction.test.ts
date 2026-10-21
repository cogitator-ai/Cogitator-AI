import { describe, it, expect, vi } from 'vitest';
import { compactedHistory, HISTORY_ENTRY_TYPES, InMemoryAdapter } from '@cogitator-ai/memory';
import type { CompactionServiceConfig, SummarizeFn } from '@cogitator-ai/memory';
import type {
  Channel,
  ChannelMessage,
  CompactionConfig,
  CompactionEvent,
  ChatResponse,
} from '@cogitator-ai/types';
import { Gateway } from '../gateway';
import { createHookRegistry } from '../hooks';

const summarizers = vi.hoisted(() => [] as SummarizeFn[]);

vi.mock('@cogitator-ai/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cogitator-ai/memory')>();
  class RecordingCompactionService extends actual.CompactionService {
    constructor(config: CompactionServiceConfig) {
      super(config);
      summarizers.push(config.summarize);
    }
  }
  return { ...actual, CompactionService: RecordingCompactionService };
});

interface SummaryRequest {
  model: string;
  messages: { role: string; content: string }[];
}

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

function msg(userId: string, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `m_${userId}`,
    channelType: 'test',
    channelId: `c_${userId}`,
    userId,
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

const DECISION =
  '[{"kind":"decision","text":"Use Postgres","evidence":[{"message":0,"quote":"picked Postgres"}]}]';

async function seed(memory: InMemoryAdapter, threadId: string, contents: string[]): Promise<void> {
  await memory.createThread('bot', {}, threadId);
  for (const [at, content] of contents.entries()) {
    const added = await memory.addEntry({
      threadId,
      message: { role: at % 2 === 0 ? 'user' : 'assistant', content },
      tokenCount: 10,
    });
    if (!added.success) throw new Error(added.error);
  }
}

async function conversation(memory: InMemoryAdapter, threadId: string) {
  const path = await memory.getPath({ threadId, types: HISTORY_ENTRY_TYPES });
  if (!path.success) throw new Error(path.error);
  return compactedHistory(path.data);
}

function setup(options: {
  memory: InMemoryAdapter;
  compaction?: CompactionConfig;
  answer?: (request: SummaryRequest) => string;
  threadKey?: (msg: ChannelMessage) => string;
}) {
  const channel = createChannel();
  const chat = vi.fn(async (request: SummaryRequest): Promise<Pick<ChatResponse, 'content'>> => ({
    content: (options.answer ?? (() => DECISION))(request),
  }));
  const getLLMBackend = vi.fn().mockReturnValue({ chat });
  const hooks = createHookRegistry();
  const compacted = vi.fn();
  hooks.on('session:compacted', compacted);
  const gateway = new Gateway({
    agent,
    channels: [channel],
    cogitator: {
      run: vi.fn().mockResolvedValue({ output: 'ok' }),
      getLLMBackend,
      resolveModel: (a: { model?: string }) => a.model,
    } as never,
    memory: options.memory,
    hooks,
    session: {
      ...(options.threadKey && { threadKey: options.threadKey }),
      compaction: options.compaction ?? {
        strategy: 'hierarchical',
        messageThreshold: 4,
        keepRecent: 2,
        keepRecentTokens: 25,
      },
    },
  });
  return { channel, chat, getLLMBackend, compacted, gateway };
}

describe('Gateway summarizer', () => {
  it('asks with the prompt and model CompactionService passes', async () => {
    summarizers.length = 0;
    const memory = new InMemoryAdapter();
    await seed(memory, 'test:u1', ['We picked Postgres.', 'noted', 'q', 'a']);
    const { gateway, chat, getLLMBackend } = setup({
      memory,
      compaction: {
        strategy: 'summary',
        threshold: 0,
        keepRecent: 2,
        summaryPrompt: 'Config prompt',
      },
    });

    await gateway.compactThread('test:u1');
    const summarize = summarizers.at(-1);
    if (!summarize) throw new Error('No summarizer was built');
    chat.mockClear();
    getLLMBackend.mockClear();

    await summarize([{ role: 'user', content: 'x' }], {
      model: 'openai/gpt-4o-mini',
      prompt: 'Passed prompt',
    });
    expect(getLLMBackend).toHaveBeenCalledWith('openai/gpt-4o-mini', undefined);
    expect(chat).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Passed prompt' },
        { role: 'user', content: 'user: x' },
      ],
    });

    await summarize([{ role: 'user', content: 'x' }]);
    expect(getLLMBackend).toHaveBeenLastCalledWith('ollama/test', undefined);
    expect(chat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'test',
        messages: expect.arrayContaining([{ role: 'system', content: 'Config prompt' }]),
      })
    );
  });

  it('falls back to the default prompt when neither the call nor the config has one', async () => {
    summarizers.length = 0;
    const memory = new InMemoryAdapter();
    await seed(memory, 'test:u1', ['We picked Postgres.', 'noted', 'q', 'a']);
    const { gateway, chat } = setup({
      memory,
      compaction: { strategy: 'summary', threshold: 0, keepRecent: 2 },
    });

    await gateway.compactThread('test:u1');

    const [request] = chat.mock.calls[0] ?? [];
    expect(request?.messages[0]?.content).toContain('Summarize the following conversation');
  });
});

describe('Gateway hierarchical compaction', () => {
  it('compacts a thread past messageThreshold into chapters of atoms, asked with the chapter prompt', async () => {
    const memory = new InMemoryAdapter();
    await seed(memory, 'test:u1', [
      'We picked Postgres.',
      'noted',
      'TODO: write tests',
      'ok',
      'latest question',
      'latest answer',
    ]);
    const { channel, chat, compacted, gateway } = setup({ memory });
    await gateway.start();

    await channel.trigger(msg('u1'));

    const [request] = chat.mock.calls[0] ?? [];
    expect(request?.messages[0]?.content).toContain('Answer with a JSON array only');
    const history = await conversation(memory, 'test:u1');
    const summary = history[0];
    expect(summary?.type).toBe('compaction');
    expect((summary?.event as CompactionEvent | undefined)?.levels?.chapters).toHaveLength(1);
    expect(String(summary?.message.content)).toContain('## Decisions\n- Use Postgres');
    expect(String(summary?.message.content)).toContain('- TODO: write tests');
    expect(history.slice(1).map((entry) => entry.message.content)).toEqual([
      'latest question',
      'latest answer',
    ]);
    expect(compacted).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'test:u1', result: expect.anything() })
    );
  });

  it('adds the configured summaryPrompt to the chapter prompt', async () => {
    const memory = new InMemoryAdapter();
    await seed(memory, 'test:u1', ['We picked Postgres.', 'noted', 'q', 'a']);
    const { chat, gateway } = setup({
      memory,
      compaction: {
        strategy: 'hierarchical',
        threshold: 0,
        keepRecent: 2,
        keepRecentTokens: 25,
        summaryPrompt: 'Mind the deadlines.',
      },
    });

    const report = await gateway.compactThread('test:u1');

    expect(report).toBe('Compacted 4 messages into 3');
    const system = chat.mock.calls[0]?.[0].messages[0]?.content ?? '';
    expect(system).toContain('Answer with a JSON array only');
    expect(system.endsWith('\n\nMind the deadlines.')).toBe(true);
  });
});

describe('Gateway.compactAll', () => {
  const long = ['We picked Postgres.', 'noted', 'more', 'more', 'q', 'a'];

  it('compacts every thread it served and every stored session, and counts them', async () => {
    const memory = new InMemoryAdapter();
    const { channel, gateway } = setup({
      memory,
      compaction: {
        strategy: 'hierarchical',
        messageThreshold: 100,
        keepRecent: 2,
        keepRecentTokens: 25,
      },
    });
    await seed(memory, 'test:u1', long);
    await seed(memory, 'test:u2', ['short', 'thread']);
    await seed(memory, 'test:u3', long);
    await gateway.start();
    await channel.trigger(msg('u1'));
    await channel.trigger(msg('u2'));
    await memory.createThread(
      'bot',
      {
        _session: true,
        userId: 'u3',
        channelType: 'test',
        channelId: 'c_u3',
        status: 'archived',
        messageCount: 6,
        lastActiveAt: new Date().toISOString(),
      },
      'session_test_u3'
    );

    const report = await gateway.compactAll();

    expect(report).toBe('Compacted 2 of 3 threads');
    expect((await conversation(memory, 'test:u1'))[0]?.type).toBe('compaction');
    expect((await conversation(memory, 'test:u3'))[0]?.type).toBe('compaction');
    expect((await conversation(memory, 'test:u2')).map((entry) => entry.message.content)).toEqual([
      'short',
      'thread',
    ]);
  });

  it('goes on past a thread that fails and lists it', async () => {
    const memory = new InMemoryAdapter();
    await seed(memory, 'test:good', long);
    await seed(memory, 'test:bad', ['BROKEN', ...long.slice(1)]);
    const { channel, gateway } = setup({
      memory,
      compaction: {
        strategy: 'hierarchical',
        messageThreshold: 100,
        keepRecent: 2,
        keepRecentTokens: 25,
      },
      answer: (request) =>
        request.messages.some((m) => m.content.includes('BROKEN')) ? 'not json' : DECISION,
    });
    await gateway.start();
    await channel.trigger(msg('bad'));
    await channel.trigger(msg('good'));

    const report = await gateway.compactAll();

    expect(report.split('\n')).toEqual([
      'Compacted 1 of 2 threads',
      'Failed (1):',
      'test:bad: The summarizer did not answer with the atoms of a chapter after 3 tries',
    ]);
    expect((await conversation(memory, 'test:good'))[0]?.type).toBe('compaction');
  });

  it('leaves stored sessions out when threads are keyed by threadKey', async () => {
    const memory = new InMemoryAdapter();
    await memory.createThread(
      'bot',
      { _session: true, userId: 'u9', channelType: 'test', channelId: 'c', status: 'active' },
      'session_test_u9'
    );
    await seed(memory, 'test:u9', long);
    const { gateway } = setup({
      memory,
      threadKey: (m) => `custom:${m.userId}`,
    });

    expect(await gateway.compactAll()).toBe('No threads to compact');
    expect((await conversation(memory, 'test:u9'))[0]?.type).not.toBe('compaction');
  });

  it('says so when compaction is not configured', async () => {
    const gateway = new Gateway({
      agent,
      channels: [createChannel()],
      cogitator: { run: vi.fn() } as never,
      memory: new InMemoryAdapter(),
    });

    expect(await gateway.compactAll()).toBe('Compaction is not configured');
  });
});
