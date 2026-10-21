import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Message,
  NewMemoryItem,
} from '@cogitator-ai/types';
import { InMemoryAdapter, MemoryItems } from '@cogitator-ai/memory';
import { createMemorySearchTools } from '../tools/memory-search-tools';
import { memoryCitations } from '../middleware/memory-citations';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { createToolContext } from './helpers/tool-context';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const day = (n: number) => new Date(Date.UTC(2026, 2, n, 9));

describe('memory search tools', () => {
  let memory: InMemoryAdapter;
  let items: MemoryItems;
  const context = createToolContext({ agentId: 'runtime-id', threadId: 't', userId: 'ana' });

  const said = (
    fields: Partial<NewMemoryItem> & Pick<NewMemoryItem, 'content'>
  ): NewMemoryItem => ({
    kind: 'fact',
    trust: 'user',
    confidence: 0.9,
    scope: { agentId: 'concierge', userId: 'ana' },
    evidence: [],
    verified: true,
    saidAt: day(1),
    sessionAt: day(1),
    ...fields,
  });

  beforeEach(async () => {
    memory = new InMemoryAdapter({ provider: 'memory' });
    await memory.connect();
    await memory.createThread('concierge', {}, 't');
    const say = (role: 'user' | 'assistant', content: string, n: number) =>
      memory.addEntry({
        threadId: 't',
        message: { role, content },
        tokenCount: 5,
        createdAt: day(n),
      });
    await say('user', 'Remind me later, my locker code at the climbing gym is 4471', 1);
    await say('assistant', 'Got it, 4471 for the climbing gym locker.', 1);
    for (let n = 0; n < 10; n++) {
      await say('user', `The bakery on the corner had fresh bread number ${n}`, 2);
      await say('assistant', `Enjoy the bread number ${n}`, 2);
    }
    items = new MemoryItems({ adapter: memory });
    await items.write([
      said({ content: 'Ana lives in Lisbon', subject: 'Ana', attribute: 'city', value: 'Lisbon' }),
      said({ content: 'Ana works at Acme', subject: 'Ana', attribute: 'employer' }),
      said({ content: 'Bo lives in Oslo', scope: { agentId: 'concierge', userId: 'bo' } }),
    ]);
  });

  function tools() {
    const [search, open, entities] = createMemorySearchTools({
      memory,
      agentId: 'concierge',
    });
    return { search, open, entities };
  }

  it('finds an old turn to open and an item to cite', async () => {
    const { search } = tools();

    const turns = await search.execute({ query: 'locker code at the climbing gym' }, context);
    const turn = turns.results.find((result) => result.kind === 'turn');
    expect(turn).toMatchObject({ kind: 'turn', date: '2026-03-01', role: 'user' });
    expect(turn?.kind === 'turn' && turn.excerpt).toContain('4471');

    const city = await search.execute({ query: 'Where does Ana live?' }, context);
    const item = city.results.find((result) => result.kind === 'item');
    expect(item).toMatchObject({ kind: 'item', text: 'Ana lives in Lisbon', type: 'fact' });
    expect(item?.kind === 'item' && item.ref).toMatch(/^item:/);
    expect(JSON.stringify(city)).not.toContain('Oslo');
  });

  it('opens turns whole with the turns around them, and names ids that are not turns', async () => {
    const { search, open } = tools();
    const found = await search.execute({ query: 'locker code at the climbing gym' }, context);
    const turn = found.results.find((result) => result.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('no turn found');

    const opened = await open.execute({ ids: [turn.id, 'not-a-turn'] }, context);

    expect(opened.turns.map((entry) => entry.text)).toEqual([
      'Remind me later, my locker code at the climbing gym is 4471',
      'Got it, 4471 for the climbing gym locker.',
    ]);
    expect(opened.turns[0]?.ref).toBe(`turn:${turn.id}`);
    expect(opened.missing).toEqual(['not-a-turn']);
  });

  it('opens no turn of another thread', async () => {
    const { open } = tools();
    await memory.createThread('concierge', {}, 'other');
    const added = await memory.addEntry({
      threadId: 'other',
      message: { role: 'user', content: 'a secret of another thread' },
      tokenCount: 5,
    });
    if (!added.success) throw new Error(added.error);

    const opened = await open.execute({ ids: [added.data.id] }, context);

    expect(opened.turns).toEqual([]);
    expect(opened.missing).toEqual([added.data.id]);
  });

  it("lists the entities the user's memory knows, with how many items are about each", async () => {
    const { entities } = tools();

    const listed = await entities.execute({}, context);

    expect(listed.entities).toContainEqual({ name: 'Ana', items: 2 });
    expect(JSON.stringify(listed)).not.toContain('Bo');
    expect((await entities.execute({ query: 'an' }, context)).entities.map((e) => e.name)).toEqual([
      'Ana',
    ]);
  });

  it('says so when nothing matches', async () => {
    const { search } = tools();

    const found = await search.execute({ query: 'quantum chromodynamics lecture' }, context);

    expect(found.results).toEqual([]);
    expect(found.note).toMatch(/do not remember/);
  });
});

describe('memoryCitations', () => {
  function scripted(answers: ((request: ChatRequest) => ChatResponse)[]): LLMBackend {
    let turn = 0;
    return {
      provider: 'openai',
      chat: vi.fn(async (request: ChatRequest) => answers[turn++]!(request)),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield { id: 's', delta: {}, finishReason: 'stop' };
      }),
    };
  }

  const refOf = (messages: readonly Message[]) => {
    const tool = messages.find((message) => message.role === 'tool');
    const match = /item:[A-Za-z0-9_-]+/.exec(String(tool?.content ?? ''));
    return match?.[0] ?? 'item:none';
  };

  it('keeps references the run opened and takes out the rest', async () => {
    const uncited = vi.fn();
    const backend = scripted([
      () => ({
        id: 'r1',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'search_memory', arguments: { query: 'Where does Ana live?' } },
        ],
        finishReason: 'tool_calls',
        usage,
      }),
      (request) => ({
        id: 'r2',
        content: `Ana lives in Lisbon [${refOf(request.messages)}], and in Paris [item:made-up].`,
        finishReason: 'stop',
        usage,
      }),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
      middleware: [memoryCitations({ onUncited: uncited })],
    });
    const memory = await cog.getMemory();
    if (!memory) throw new Error('no memory');
    await new MemoryItems({ adapter: memory as InMemoryAdapter }).write([
      {
        kind: 'fact',
        content: 'Ana lives in Lisbon',
        subject: 'Ana',
        attribute: 'city',
        value: 'Lisbon',
        trust: 'user',
        confidence: 0.9,
        scope: { agentId: 'concierge', userId: 'ana' },
        evidence: [],
        verified: true,
        saidAt: day(1),
        sessionAt: day(1),
      },
    ]);
    const agent = new Agent({
      name: 'concierge',
      model: 'mock/m',
      instructions: 'x',
      tools: await cog.memorySearchTools('concierge'),
    });

    const result = await cog.run(agent, { input: 'Where does Ana live?', userId: 'ana' });
    await cog.close();

    expect(result.output).toMatch(/^Ana lives in Lisbon \[item:[^\]]+\], and in Paris\.$/);
    expect(uncited).toHaveBeenCalledWith(['item:made-up'], expect.anything());
  });

  it('leaves an answer without references as it is', async () => {
    const backend = scripted([
      () => ({ id: 'r', content: 'I do not remember that.', finishReason: 'stop', usage }),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      middleware: [memoryCitations()],
    });

    const result = await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), {
      input: 'What is my locker code?',
    });
    await cog.close();

    expect(result.output).toBe('I do not remember that.');
  });
});
