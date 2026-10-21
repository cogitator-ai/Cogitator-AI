import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  RunMiddleware,
  ToolCall,
} from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';
import { InMemoryThreadStorage } from '../client/storage';
import type { StoredThread } from '../client/thread-manager';

let threadToForget: string | null = null;
let breakStorage = false;
let server: OpenAIServer;

const forget = tool({
  name: 'forget',
  description: 'Forget the conversation',
  parameters: z.object({}),
  execute: async () => {
    if (threadToForget) await server.getAdapter().deleteThread(threadToForget);
    if (breakStorage) storage.failing = true;
    return { forgotten: true };
  },
});

let toolTurn: ToolCall[] = [];
/** How many turns in a row call the tools of `toolTurn` */
let toolTurns = 1;

function answer(request: ChatRequest): ChatResponse {
  const results = request.messages.filter((m) => m.role === 'tool');
  if (toolTurn.length > 0 && results.length < toolTurns * toolTurn.length) {
    const turn = results.length / toolTurn.length;
    return {
      id: 'r1',
      content: 'Your card is 4111 1111 1111 1111, checking.',
      toolCalls: toolTurn.map((call) => ({
        ...call,
        id: turn === 0 ? call.id : `${call.id}_${turn}`,
      })),
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
  return {
    id: 'r2',
    content: 'Done with 4111 1111 1111 1111.',
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
  };
}

const backend: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(async (request: ChatRequest) => answer(request)),
  chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const response = answer(request);
    if (response.content) yield { id: response.id, delta: { content: response.content } };
    if (response.toolCalls) yield { id: response.id, delta: { toolCalls: response.toolCalls } };
    yield {
      id: response.id,
      delta: {},
      finishReason: response.finishReason,
      usage: response.usage,
    };
  }),
};

let holdStream = true;

const redactCards: RunMiddleware = {
  name: 'redact-cards',
  get holdsStream() {
    return holdStream;
  },
  afterModel: ({ response }) => ({
    content: response.content.replace(/\d{4}( \d{4}){3}/g, '[card]'),
  }),
};

/** Storage whose thread writes take a while, so an event sent before the write shows */
class SlowStorage extends InMemoryThreadStorage {
  delayMs = 0;
  failing = false;
  private saved = new Map<string, StoredThread>();

  override async saveThread(id: string, thread: StoredThread): Promise<void> {
    if (this.failing) throw new Error('storage is down');
    const copy = structuredClone(thread);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await super.saveThread(id, copy);
    this.saved.set(id, copy);
  }

  /** The thread as the last finished write left it */
  peek(id: string): StoredThread | undefined {
    return this.saved.get(id);
  }
}

const POLL = { pollIntervalMs: 10 };

const weatherFunction = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};
const storage = new SlowStorage();

describe('messages of a run', () => {
  let cogitator: Cogitator;
  let client: OpenAI;

  beforeAll(async () => {
    cogitator = new Cogitator({
      llm: { backends: { mock: backend } },
      middleware: [redactCards],
    });
    server = new OpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      defaultModel: 'mock/m',
      tools: [forget],
      storage,
    });
    await server.start();
    client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
  });

  afterAll(async () => {
    await server.stop();
    await cogitator.close();
  });

  beforeEach(() => {
    toolTurn = [];
    toolTurns = 1;
    threadToForget = null;
    breakStorage = false;
    storage.delayMs = 0;
    storage.failing = false;
    holdStream = true;
  });

  async function start(tools: OpenAI.Beta.AssistantTool[] = []) {
    const assistant = await client.beta.assistants.create({ model: 'cogitator', tools });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'Check my card' }],
    });
    return { assistant, thread };
  }

  async function texts(threadId: string, runId: string): Promise<string[]> {
    const page = await client.beta.threads.messages.list(threadId, {
      order: 'asc',
      run_id: runId,
    });
    return page.data.map((m) => (m.content[0]?.type === 'text' ? m.content[0].text.value : ''));
  }

  it('stores the text of a tool turn as the middleware left it, with or without a stream', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    const expected = ['Your card is [card], checking.', 'Done with [card].'];

    const polled = await start();
    const run = await client.beta.threads.runs.createAndPoll(
      polled.thread.id,
      { assistant_id: polled.assistant.id },
      POLL
    );
    expect(run.status).toBe('completed');
    expect(await texts(polled.thread.id, run.id)).toEqual(expected);

    const streamed = await start();
    const stream = client.beta.threads.runs.stream(streamed.thread.id, {
      assistant_id: streamed.assistant.id,
    });
    const streamedRun = await stream.finalRun();
    expect(streamedRun.status).toBe('completed');
    expect(await texts(streamed.thread.id, streamedRun.id)).toEqual(expected);
    expect(
      (await stream.finalMessages()).map((m) =>
        m.content[0]?.type === 'text' ? m.content[0].text.value : ''
      )
    ).toEqual(expected);
  });

  it('sends a completed message only once it is stored, keeping the order of the events', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    storage.delayMs = 40;
    const { assistant, thread } = await start();

    const events: string[] = [];
    const found: boolean[] = [];
    const stream = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistant.id })
      .on('event', (event) => {
        events.push(event.event);
        if (event.event === 'thread.message.completed') {
          const { id } = event.data;
          found.push(
            storage.peek(thread.id)?.messages.some((message) => message.id === id) ?? false
          );
        }
      });
    const run = await stream.finalRun();

    expect(run.status).toBe('completed');
    expect(found).toEqual([true, true]);
    const ordered = events.filter((event) => event !== 'thread.message.delta');
    expect(ordered.indexOf('thread.message.completed')).toBeLessThan(
      ordered.indexOf('thread.run.step.completed')
    );
    expect(ordered.lastIndexOf('thread.message.completed')).toBeLessThan(
      ordered.indexOf('thread.run.completed')
    );
  });

  it('fails the run when its thread is deleted while it runs', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    const { assistant, thread } = await start();
    threadToForget = thread.id;

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );

    expect(run.status).toBe('failed');
    expect(run.last_error?.code).toBe('server_error');
  });

  it('fails the run and ends a message the storage did not keep as incomplete', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    breakStorage = true;
    const { assistant, thread } = await start();

    const events: string[] = [];
    const stream = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistant.id })
      .on('event', (event) => events.push(event.event));
    const run = await stream.finalRun();

    const count = (name: string) => events.filter((event) => event === name).length;
    expect(run.status).toBe('failed');
    expect(count('thread.message.completed')).toBe(0);
    expect(count('thread.message.incomplete')).toBe(count('thread.message.created'));
    expect(count('thread.message.created')).toBeGreaterThan(0);
    expect(events.at(-1)).toBe('thread.run.failed');
  });

  it('stores the redacted text of a streamed tool turn when the middleware does not hold the stream', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    holdStream = false;
    const { assistant, thread } = await start();

    const run = await client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistant.id })
      .finalRun();

    expect(run.status).toBe('completed');
    expect(await texts(thread.id, run.id)).toEqual([
      'Your card is [card], checking.',
      'Done with [card].',
    ]);
  });

  it('streams the rest of a run submitted right after a pause the store held up', async () => {
    toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }];
    storage.delayMs = 150;
    const { assistant, thread } = await start([weatherFunction]);

    const paused = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    expect(paused.status).toBe('requires_action');
    const stream = client.beta.threads.runs.submitToolOutputsStream(paused.id, {
      thread_id: thread.id,
      tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }],
    });
    const done = await stream.finalRun();

    expect(done.status).toBe('completed');
    expect(
      (await stream.finalMessages()).map((m) =>
        m.content[0]?.type === 'text' ? m.content[0].text.value : ''
      )
    ).toEqual(['Done with [card].']);
  });

  it('fails a run whose message before a pause was not stored, without asking for outputs', async () => {
    toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }];
    const { assistant, thread } = await start([weatherFunction]);
    storage.failing = true;

    const events: string[] = [];
    const stream = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistant.id })
      .on('event', (event) => events.push(event.event));
    const run = await stream.finalRun();
    storage.failing = false;
    const steps = await client.beta.threads.runs.steps.list(run.id, {
      thread_id: thread.id,
      order: 'asc',
    });

    expect(run.status).toBe('failed');
    expect(events).not.toContain('thread.run.requires_action');
    expect(events).toContain('thread.message.incomplete');
    expect(steps.data.map((step) => [step.type, step.status])).toEqual([
      ['message_creation', 'failed'],
      ['tool_calls', 'failed'],
    ]);
  });

  it('finishes a run and frees its thread when a listener of its events throws', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    storage.delayMs = 20;
    const { assistant, thread } = await start();
    const adapter = server.getAdapter();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = await adapter.createRun(thread.id, { assistant_id: assistant.id });
    let thrown = false;
    adapter.getStreamEmitter(run.id)?.on('event', (event) => {
      if (event !== 'thread.run.step.completed' || thrown) return;
      thrown = true;
      throw new Error('listener broke');
    });
    const first = await client.beta.threads.runs.poll(run.id, { thread_id: thread.id }, POLL);
    storage.delayMs = 0;
    const second = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const logged = errors.mock.calls.some(([text]) => String(text).includes('A listener of run'));
    errors.mockRestore();

    expect(thrown).toBe(true);
    expect(logged).toBe(true);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
  });

  it('records the turn that repeats the same call as its own message and tool_calls step', async () => {
    toolTurn = [{ id: 'call_1', name: 'forget', arguments: {} }];
    toolTurns = 2;
    const { assistant, thread } = await start();

    const stream = client.beta.threads.runs.stream(thread.id, { assistant_id: assistant.id });
    const run = await stream.finalRun();
    const steps = await client.beta.threads.runs.steps.list(run.id, {
      thread_id: thread.id,
      order: 'asc',
    });

    expect(run.status).toBe('completed');
    expect(steps.data.map((step) => [step.type, step.status])).toEqual([
      ['message_creation', 'completed'],
      ['tool_calls', 'completed'],
      ['message_creation', 'completed'],
      ['tool_calls', 'completed'],
      ['message_creation', 'completed'],
    ]);
    const repeated = steps.data[3]!.step_details;
    expect(repeated.type === 'tool_calls' && repeated.tool_calls).toEqual([
      expect.objectContaining({
        id: 'call_1_1',
        function: expect.objectContaining({
          output: expect.stringContaining('Duplicate tool call detected'),
        }),
      }),
    ]);
    expect(await texts(thread.id, run.id)).toEqual([
      'Your card is [card], checking.',
      'Your card is [card], checking.',
      'Done with [card].',
    ]);
  });
});
