import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MockLLMBackend, type MockStreamChunk } from '@cogitator-ai/test-utils';
import {
  INTERRUPTED_REPLY_NOTE,
  type MemoryAdapter,
  type MemoryEntry,
  type RunMiddleware,
} from '@cogitator-ai/types';
import { createCogitatorRunner, type CogitatorLike } from '../cogitator-runner';
import { PipelineSession } from '../pipeline/pipeline-session';
import type { TTSProvider, VoiceAgentRunner, VoiceTurn } from '../types';

const cogitators: Cogitator[] = [];

function runtime(backend: MockLLMBackend): Cogitator {
  const cogitator = new Cogitator({
    llm: { backends: { mock: backend }, retry: false },
    memory: { adapter: 'memory' },
  });
  cogitators.push(cogitator);
  return cogitator;
}

afterEach(async () => {
  await Promise.all(cogitators.splice(0).map((c) => c.close()));
});

async function memoryOf(cogitator: Cogitator): Promise<MemoryAdapter> {
  const memory = await cogitator.getMemory();
  if (!memory) throw new Error('memory is not configured');
  return memory;
}

async function path(cogitator: Cogitator, threadId: string, types?: 'all'): Promise<MemoryEntry[]> {
  const result = await (
    await memoryOf(cogitator)
  ).getPath!({
    threadId,
    includeToolCalls: true,
    ...(types && { types }),
  });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

async function allEntries(cogitator: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const result = await (await memoryOf(cogitator)).getEntries({ threadId, types: 'all' });
  if (!result.success) throw new Error(result.error);
  return result.data;
}

const said = (entries: MemoryEntry[]) =>
  entries.map((e) => [e.type, e.message.role, String(e.message.content)]);

async function readAll(turn: VoiceTurn): Promise<string[]> {
  const deltas: string[] = [];
  for await (const delta of turn) deltas.push(delta);
  return deltas;
}

const agent = new Agent({ name: 'voice', model: 'mock/m', instructions: 'Answer briefly.' });
const chunks = (...texts: string[]): MockStreamChunk[] => texts.map((content) => ({ content }));

const weather = tool({
  name: 'weather',
  description: 'Weather of a city',
  parameters: z.object({ city: z.string() }),
  execute: async () => ({ sky: 'sunny' }),
});
const toolAgent = new Agent({
  name: 'voice-tools',
  model: 'mock/m',
  instructions: 'Answer briefly.',
  tools: [weather],
});
const toolTurn: MockStreamChunk[] = [
  { content: 'Let me check. ' },
  {
    toolCalls: [{ id: 'c1', name: 'weather', arguments: { city: 'Paris' } }],
    finishReason: 'tool_calls',
  },
];

function agentWith(middleware: RunMiddleware[]): Agent {
  return new Agent({ name: 'voice-mw', model: 'mock/m', instructions: 'Answer.', middleware });
}

async function allOf(turn: VoiceTurn): Promise<{ deltas: string[]; answer: unknown }> {
  const iterator = turn[Symbol.asyncIterator]();
  const deltas: string[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { deltas, answer: next.value };
    deltas.push(next.value);
  }
}

describe('createCogitatorRunner streaming with a Cogitator', () => {
  it('streams the answer and leaves a fully spoken turn as run() does', async () => {
    const backend = new MockLLMBackend().setStreamChunks(
      chunks('Hello there. ', 'How are ', 'you?')
    );
    backend.setResponse({ content: 'Hello there. How are you?' });
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);

    const turn = runner.stream!('Hi', { sessionId: 's1', signal: new AbortController().signal });
    expect(await readAll(turn)).toEqual(['Hello there. ', 'How are ', 'you?']);
    await turn.settle!({ spoken: 'Hello there. How are you?', interrupted: false });

    await runner.run('Hi', { sessionId: 's2' });

    const streamed = await allEntries(cogitator, 'voice:s1');
    const ran = await allEntries(cogitator, 'voice:s2');
    expect(said(streamed)).toEqual(said(ran));
    expect(said(streamed)).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'Hello there. How are you?'],
    ]);
    expect(streamed.map((e) => e.metadata?.interrupted)).toEqual([undefined, undefined]);
  });

  it('keeps only the spoken part of an answer interrupted while it was spoken', async () => {
    const backend = new MockLLMBackend().setStreamChunks(chunks('Hello there. ', 'How are you?'));
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    await readAll(turn);
    await turn.settle!({ spoken: 'Hello there. ', interrupted: true });

    const entries = await allEntries(cogitator, 'voice:s');
    expect(said(entries)).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'Hello there.'],
    ]);
    expect(entries[1]!.metadata).toEqual({ interrupted: true });
    expect(entries[1]!.parentId).toBe(entries[0]!.id);
    const thread = await (await memoryOf(cogitator)).getThread('voice:s');
    expect(thread.success && thread.data?.activeLeafId).toBe(entries[1]!.id);
  });

  it('removes the answer when none of it was spoken', async () => {
    const backend = new MockLLMBackend().setStreamChunks(chunks('Hello there.'));
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    await readAll(turn);
    await turn.settle!({ spoken: '', interrupted: true });

    const entries = await allEntries(cogitator, 'voice:s');
    expect(said(entries)).toEqual([['message', 'user', 'Hi']]);
    const thread = await (await memoryOf(cogitator)).getThread('voice:s');
    expect(thread.success && thread.data?.activeLeafId).toBe(entries[0]!.id);
  });

  it('saves the spoken part of an answer interrupted mid-generation', async () => {
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'First sentence. ' },
      { content: 'Second', delay: 1_000 },
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);
    const controller = new AbortController();

    const turn = runner.stream!('Hi', { sessionId: 's', signal: controller.signal });
    const iterator = turn[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 'First sentence. ' });
    controller.abort(new Error('the user interrupted'));
    await expect(iterator.next()).rejects.toThrow('the user interrupted');
    await turn.settle!({ spoken: 'First sentence. ', interrupted: true });

    expect(said(await path(cogitator, 'voice:s', 'all'))).toEqual([
      ['message', 'user', 'Hi'],
      ['interrupt', 'system', 'The run was interrupted: the user interrupted'],
      ['message', 'assistant', 'First sentence.'],
    ]);
    const conversation = await path(cogitator, 'voice:s');
    expect(said(conversation)).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'First sentence.'],
    ]);
    expect(conversation[1]!.metadata).toEqual({ interrupted: true });
  });

  it('saves no assistant message when a run is interrupted before anything was spoken', async () => {
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'Thinking' },
      { content: ' more', delay: 1_000 },
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);
    const controller = new AbortController();

    const turn = runner.stream!('Hi', { sessionId: 's', signal: controller.signal });
    const iterator = turn[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await iterator.next().catch(() => undefined);
    await turn.settle!({ spoken: '', interrupted: true });

    expect(
      said(await path(cogitator, 'voice:s', 'all')).map(([type, role]) => [type, role])
    ).toEqual([
      ['message', 'user'],
      ['interrupt', 'system'],
    ]);
  });

  it('gives the next turn the spoken part as the answer it heard', async () => {
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      chunks('Paris is the capital. ', 'It has the Louvre.'),
      chunks('Sure.'),
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);
    const signal = new AbortController().signal;

    const first = runner.stream!('Capital of France?', { sessionId: 's', signal });
    await readAll(first);
    await first.settle!({ spoken: 'Paris is the capital. ', interrupted: true });
    const second = runner.stream!('Thanks', { sessionId: 's', signal });
    await readAll(second);
    await second.settle!({ spoken: 'Sure.', interrupted: false });

    const sent = backend.getLastCall()!.messages.filter((m) => m.role !== 'system');
    expect(sent.map((m) => [m.role, String(m.content)])).toEqual([
      ['user', 'Capital of France?'],
      ['assistant', `Paris is the capital. ${INTERRUPTED_REPLY_NOTE}`],
      ['user', 'Thanks'],
    ]);
  });

  it('keeps text said alongside tool calls and settles only the final answer', async () => {
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      toolTurn,
      chunks('It is sunny. ', 'Enjoy the day.'),
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, toolAgent);

    const turn = runner.stream!('Weather?', {
      sessionId: 's',
      signal: new AbortController().signal,
    });
    expect((await readAll(turn)).join('')).toBe('Let me check. \nIt is sunny. Enjoy the day.');
    await turn.settle!({ spoken: 'Let me check. \nIt is sunny. ', interrupted: true });

    const conversation = await path(cogitator, 'voice:s');
    expect(said(conversation)).toEqual([
      ['message', 'user', 'Weather?'],
      ['message', 'assistant', 'Let me check. '],
      ['tool_result', 'tool', expect.stringContaining('sunny')],
      ['message', 'assistant', 'It is sunny.'],
    ]);
    expect(conversation[1]!.toolCalls?.map((call) => call.name)).toEqual(['weather']);
    expect(conversation[3]!.metadata).toEqual({ interrupted: true });
  });

  it('ends the stream with the final answer, as run() returns it', async () => {
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      toolTurn,
      chunks('It is sunny. ', 'Enjoy the day.'),
    ]);
    const runner = createCogitatorRunner(runtime(backend), toolAgent);

    const { deltas, answer } = await allOf(
      runner.stream!('Weather?', { sessionId: 's', signal: new AbortController().signal })
    );

    expect(deltas).toEqual(['Let me check. ', '\n', 'It is sunny. ', 'Enjoy the day.']);
    expect(answer).toBe('It is sunny. Enjoy the day.');
  });

  it('settles a turn interrupted while the answer after a tool was generated', async () => {
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      toolTurn,
      [{ content: 'It is sunny. ' }, { content: 'And warm.', delay: 1_000 }],
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, toolAgent);
    const controller = new AbortController();

    const turn = runner.stream!('Weather?', { sessionId: 's', signal: controller.signal });
    const iterator = turn[Symbol.asyncIterator]();
    const seen: string[] = [];
    while (!seen.join('').endsWith('It is sunny. ')) {
      const next = await iterator.next();
      if (next.done) throw new Error('the stream ended early');
      seen.push(next.value);
    }
    controller.abort(new Error('barge-in'));
    await iterator.next().catch(() => undefined);
    await turn.settle!({ spoken: seen.join(''), interrupted: true });

    expect(said(await path(cogitator, 'voice:s', 'all'))).toEqual([
      ['message', 'user', 'Weather?'],
      ['message', 'assistant', 'Let me check. '],
      ['tool_result', 'tool', expect.stringContaining('sunny')],
      ['interrupt', 'system', 'The run was interrupted: barge-in'],
      ['message', 'assistant', 'It is sunny.'],
    ]);
  });

  it('ends the stream at the final model turn, before the run finishes', async () => {
    let afterRunDone = false;
    const slowAfterRun: RunMiddleware = {
      name: 'slow-after-run',
      afterRun: async () => {
        await new Promise((r) => setTimeout(r, 200));
        afterRunDone = true;
      },
    };
    const backend = new MockLLMBackend().setStreamChunks(chunks('Done now.'));
    const runner = createCogitatorRunner(runtime(backend), agentWith([slowAfterRun]));

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    expect(await readAll(turn)).toEqual(['Done now.']);
    expect(afterRunDone).toBe(false);
    await turn.settle!({ spoken: 'Done now.', interrupted: false });
    expect(afterRunDone).toBe(true);
  });

  it('replaces a saved answer when the run fails after saving it, and reports the failure', async () => {
    const backend = new MockLLMBackend().setStreamChunks(chunks('First. ', 'Second.'));
    const cogitator = runtime(backend);
    const failsLate: CogitatorLike<Agent> = {
      run: async (target, options) => {
        await cogitator.run(target, options);
        throw new Error('recording the run failed');
      },
      getMemory: () => cogitator.getMemory(),
    };
    const runner = createCogitatorRunner(failsLate, agent);

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    expect((await readAll(turn)).join('')).toBe('First. Second.');
    await expect(turn.settle!({ spoken: 'First. ', interrupted: true })).rejects.toThrow(
      'recording the run failed'
    );

    expect(said(await path(cogitator, 'voice:s'))).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'First.'],
    ]);
  });

  it('does not say the output again when a run pauses for an approval', async () => {
    const book = tool({
      name: 'book',
      description: 'Book',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'ok',
    });
    const booking = new Agent({
      name: 'booking',
      model: 'mock/m',
      instructions: 'x',
      tools: [book],
    });
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'Booking it now.' },
      { toolCalls: [{ id: 'c1', name: 'book', arguments: {} }], finishReason: 'tool_calls' },
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, booking);
    const run = await cogitator.run(booking, {
      input: 'Book',
      threadId: 'plain',
      stream: true,
      onToken: () => undefined,
    });

    const { deltas, answer } = await allOf(
      runner.stream!('Book', { sessionId: 's', signal: new AbortController().signal })
    );

    expect(run.status).toBe('paused');
    expect(deltas).toEqual(['Booking it now.', '\n']);
    expect(answer).toBe(run.output);
  });

  it('does not say the output again when a run stops at its iteration limit', async () => {
    const limited = new Agent({
      name: 'limited',
      model: 'mock/m',
      instructions: 'x',
      tools: [weather],
      maxIterations: 1,
      onIterationLimit: 'stop',
    });
    const backend = new MockLLMBackend().setStreamChunks(toolTurn);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, limited);
    const run = await cogitator.run(limited, {
      input: 'Weather?',
      threadId: 'plain',
      stream: true,
      onToken: () => undefined,
    });

    const { deltas, answer } = await allOf(
      runner.stream!('Weather?', { sessionId: 's', signal: new AbortController().signal })
    );

    expect(run.iterationLimitReached).toBe(true);
    expect(deltas).toEqual(['Let me check. ', '\n']);
    expect(answer).toBe(run.output);
  });

  it('settles once the answer is saved and starts the next run after the slow tail', async () => {
    let tailsDone = 0;
    const slowTail: RunMiddleware = {
      name: 'slow-tail',
      afterRun: async () => {
        await new Promise((r) => setTimeout(r, 300));
        tailsDone++;
      },
    };
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      chunks('One. ', 'Two.'),
      chunks('Next.'),
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agentWith([slowTail]));
    const signal = new AbortController().signal;

    const first = runner.stream!('Hi', { sessionId: 's', signal });
    await readAll(first);
    const settled = first.settle!({ spoken: 'One. ', interrupted: true });
    await vi.waitFor(async () =>
      expect(said(await path(cogitator, 'voice:s')).at(-1)).toEqual([
        'message',
        'assistant',
        'One.',
      ])
    );
    expect(tailsDone).toBe(0);

    const second = runner.stream!('Again', { sessionId: 's', signal });
    const reading = readAll(second);
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.getCallCount()).toBe(1);
    expect(await reading).toEqual(['Next.']);
    expect(tailsDone).toBeGreaterThanOrEqual(1);
    await settled;
    await second.settle!({ spoken: 'Next.', interrupted: false });

    expect(said(await path(cogitator, 'voice:s'))).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'One.'],
      ['message', 'user', 'Again'],
      ['message', 'assistant', 'Next.'],
    ]);
  });

  it('settles once however often settle is called', async () => {
    const backend = new MockLLMBackend().setStreamChunks(chunks('One. ', 'Two.'));
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    await readAll(turn);
    const first = turn.settle!({ spoken: 'One. ', interrupted: true });
    const second = turn.settle!({ spoken: '', interrupted: true });
    expect(second).toBe(first);
    await first;

    expect(said(await path(cogitator, 'voice:s'))).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'One.'],
    ]);
  });

  it('leaves the thread untouched when something was written after the turn', async () => {
    const backend = new MockLLMBackend().setStreamChunks(chunks('One. ', 'Two.'));
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    await readAll(turn);
    const memory = await memoryOf(cogitator);
    await memory.addEntry({
      threadId: 'voice:s',
      message: { role: 'user', content: 'typed meanwhile' },
      tokenCount: 4,
    });
    await turn.settle!({ spoken: 'One. ', interrupted: true });

    expect(said(await path(cogitator, 'voice:s'))).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'One. Two.'],
      ['message', 'user', 'typed meanwhile'],
    ]);
  });

  it('runs the settles of one thread one after another', async () => {
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      chunks('A one. ', 'A two.'),
      chunks('B one. ', 'B two.'),
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);
    const signal = new AbortController().signal;

    const first = runner.stream!('First', { sessionId: 's', signal });
    await readAll(first);
    const second = runner.stream!('Second', { sessionId: 's', signal });
    await readAll(second);
    await Promise.all([
      second.settle!({ spoken: 'B one. ', interrupted: true }),
      first.settle!({ spoken: 'A one. ', interrupted: true }),
    ]);

    expect(said(await path(cogitator, 'voice:s'))).toEqual([
      ['message', 'user', 'First'],
      ['message', 'assistant', 'A one. A two.'],
      ['message', 'user', 'Second'],
      ['message', 'assistant', 'B one.'],
    ]);
  });

  it('stops the run when the reader stops early', async () => {
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'One. ' },
      { content: 'Two.', delay: 1_000 },
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, agent);

    const turn = runner.stream!('Hi', { sessionId: 's', signal: new AbortController().signal });
    const iterator = turn[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return!();
    await turn.settle!({ spoken: 'One. ', interrupted: true });

    expect(said(await path(cogitator, 'voice:s'))).toEqual([
      ['message', 'user', 'Hi'],
      ['message', 'assistant', 'One.'],
    ]);
  });
});

describe('PipelineSession with createCogitatorRunner and a Cogitator', () => {
  function recordingTTS(holdFrom = Infinity): { tts: TTSProvider; spoken: string[] } {
    const spoken: string[] = [];
    return {
      spoken,
      tts: {
        name: 'recording',
        synthesize: async (text) => Buffer.from(text),
        async *streamSynthesize(text) {
          spoken.push(text);
          if (spoken.length >= holdFrom) await new Promise(() => undefined);
          yield Buffer.from(text);
        },
      },
    };
  }

  function sessionFor(runner: VoiceAgentRunner, tts: TTSProvider) {
    const session = new PipelineSession(
      { stt: { name: 'unused', transcribe: vi.fn(), createStream: vi.fn() }, tts, agent: runner },
      { sessionId: 's' }
    );
    const events = { responses: [] as string[], deltas: [] as string[], turnEnds: 0 };
    session.on('agent_response', (text) => events.responses.push(text));
    session.on('agent_response_delta', (delta) => events.deltas.push(delta));
    session.on('turn_end', () => events.turnEnds++);
    return { session, events };
  }

  it('speaks what is said before a tool on its own and announces the final answer', async () => {
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      toolTurn,
      chunks('It is sunny. ', 'Enjoy the day.'),
    ]);
    const cogitator = runtime(backend);
    const { tts, spoken } = recordingTTS();
    const { session, events } = sessionFor(createCogitatorRunner(cogitator, toolAgent), tts);

    await session.sendText('Weather?');
    await session.close();

    expect(spoken).toEqual(['Let me check.', 'It is sunny.', 'Enjoy the day.']);
    expect(events.responses).toEqual(['It is sunny. Enjoy the day.']);
    expect(events.deltas.join('')).toBe('Let me check. \nIt is sunny. Enjoy the day.');
    expect(events.turnEnds).toBe(1);
    expect(said(await path(cogitator, 'voice:s')).at(-1)).toEqual([
      'message',
      'assistant',
      'It is sunny. Enjoy the day.',
    ]);
  });

  it('keeps only the spoken sentences when the reply is interrupted', async () => {
    const backend = new MockLLMBackend().setStreamChunks(
      chunks('First sentence. ', 'Second sentence. ', 'Third sentence.')
    );
    const cogitator = runtime(backend);
    const { tts, spoken } = recordingTTS(2);
    const { session } = sessionFor(createCogitatorRunner(cogitator, agent), tts);

    void session.sendText('Talk');
    await vi.waitFor(() => expect(spoken).toHaveLength(2));
    session.interrupt();

    await vi.waitFor(async () =>
      expect(said(await path(cogitator, 'voice:s'))).toEqual([
        ['message', 'user', 'Talk'],
        ['message', 'assistant', 'First sentence.'],
      ])
    );
    const thread = await path(cogitator, 'voice:s');
    expect(thread[1]!.metadata).toEqual({ interrupted: true });
    await session.close();
  });
});
