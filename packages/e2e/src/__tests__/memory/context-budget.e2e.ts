import { describe, it, expect, afterEach } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { ContextBuilder, InMemoryAdapter } from '@cogitator-ai/memory';
import { startFakeOllama, type FakeOllama } from '../../helpers/fake-ollama';

const MODEL = 'qwen2.5:0.5b';
const turn = (i: number) =>
  `Turn ${i}: ${'the parcel passed another sorting depot today. '.repeat(25)}`;

let fake: FakeOllama | undefined;
let cogitator: Cogitator | undefined;

afterEach(async () => {
  await cogitator?.close();
  await fake?.close();
  cogitator = undefined;
  fake = undefined;
});

async function runOnLongThread(contextBuilder: { maxTokens?: number }): Promise<string[]> {
  fake = await startFakeOllama(() => ({ content: 'Still in transit.' }), [MODEL]);
  cogitator = new Cogitator({
    llm: { providers: { ollama: { baseUrl: fake.url } } },
    memory: { adapter: 'memory', contextBuilder: { strategy: 'recent', ...contextBuilder } },
  });
  const agent = new Agent({
    id: 'tracker',
    name: 'tracker',
    model: `ollama/${MODEL}`,
    instructions: 'Track parcels.',
  });
  await cogitator.run(agent, { input: 'start', threadId: 'warmup' });
  const memory = cogitator.memory!;
  await memory.createThread('tracker', {}, 'parcel-thread');
  for (let i = 0; i < 24; i++) {
    await memory.addEntry({
      threadId: 'parcel-thread',
      message: { role: i % 2 === 0 ? 'user' : 'assistant', content: turn(i) },
      tokenCount: 0,
    });
  }
  fake.requests.length = 0;

  await cogitator.run(agent, {
    input: 'Where is it?',
    threadId: 'parcel-thread',
    threadAccess: 'shared',
  });

  return fake.requests[0]!.messages.map((m) => m.content).filter((content) =>
    content.startsWith('Turn ')
  );
}

describe('Memory: context budget of a run', () => {
  it('sends the history that fits the model window, more than the old 4000 tokens', async () => {
    const history = await runOnLongThread({});

    expect(history).toHaveLength(24);
  });

  it('keeps to an explicit maxTokens', async () => {
    const history = await runOnLongThread({ maxTokens: 2000 });

    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(24);
    expect(history.at(-1)).toBe(turn(23));
  });

  it('reports what a standalone builder left out', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
    await adapter.createThread('tracker', {}, 'standalone');
    for (let i = 0; i < 24; i++) {
      await adapter.addEntry({
        threadId: 'standalone',
        message: { role: i % 2 === 0 ? 'user' : 'assistant', content: turn(i) },
        tokenCount: 0,
      });
    }
    const builder = new ContextBuilder({ strategy: 'recent' }, { memoryAdapter: adapter });

    const small = await builder.build({
      threadId: 'standalone',
      agentId: 'tracker',
      maxTokens: 1500,
    });
    const large = await builder.build({
      threadId: 'standalone',
      agentId: 'tracker',
      maxTokens: 128_000,
    });

    expect(small.dropped.entries.length).toBeGreaterThan(0);
    expect(small.dropped.entries.length + small.metadata.includedMessageCount).toBe(24);
    expect(small.dropped.tokenCount).toBeGreaterThan(0);
    expect(large.dropped.entries).toEqual([]);
    expect(large.truncated).toBe(false);
    await adapter.disconnect();
  });
});
