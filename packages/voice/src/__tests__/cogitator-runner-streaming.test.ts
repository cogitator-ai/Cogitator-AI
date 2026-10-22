import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MockLLMBackend, type MockStreamChunk } from '@cogitator-ai/test-utils';
import type { MemoryAdapter, MemoryEntry } from '@cogitator-ai/types';
import { createCogitatorRunner } from '../cogitator-runner';
import type { VoiceTurn } from '../types';

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
      { content: 'Second', delay: 5_000 },
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
      { content: ' more', delay: 5_000 },
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
      ['assistant', 'Paris is the capital.'],
      ['user', 'Thanks'],
    ]);
  });

  it('keeps text said alongside tool calls and settles only the final answer', async () => {
    const lookup = tool({
      name: 'weather',
      description: 'Weather of a city',
      parameters: z.object({ city: z.string() }),
      execute: async () => ({ sky: 'sunny' }),
    });
    const toolAgent = new Agent({
      name: 'voice-tools',
      model: 'mock/m',
      instructions: 'Answer briefly.',
      tools: [lookup],
    });
    const backend = new MockLLMBackend().setMultipleStreamChunks([
      [
        { content: 'Let me check. ' },
        {
          toolCalls: [{ id: 'c1', name: 'weather', arguments: { city: 'Paris' } }],
          finishReason: 'tool_calls',
        },
      ],
      chunks('It is sunny. ', 'Enjoy the day.'),
    ]);
    const cogitator = runtime(backend);
    const runner = createCogitatorRunner(cogitator, toolAgent);

    const turn = runner.stream!('Weather?', {
      sessionId: 's',
      signal: new AbortController().signal,
    });
    expect((await readAll(turn)).join('')).toBe('Let me check. It is sunny. Enjoy the day.');
    await turn.settle!({ spoken: 'Let me check. It is sunny. ', interrupted: true });

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

  it('stops the run when the reader stops early', async () => {
    const backend = new MockLLMBackend().setStreamChunks([
      { content: 'One. ' },
      { content: 'Two.', delay: 5_000 },
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
