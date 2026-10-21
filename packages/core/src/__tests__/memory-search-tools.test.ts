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

  it("leaves the run's own question out of what it finds", async () => {
    await memory.addEntry({
      threadId: 't',
      message: { role: 'user', content: 'What is my locker code at the climbing gym?' },
      tokenCount: 5,
    });
    const { search } = tools();

    const found = await search.execute({ query: 'locker code at the climbing gym' }, context);

    const excerpts = found.results.flatMap((result) =>
      result.kind === 'turn' ? [result.excerpt] : []
    );
    expect(excerpts).not.toContain('What is my locker code at the climbing gym?');
    expect(excerpts.some((excerpt) => excerpt.includes('4471'))).toBe(true);
  });

  it("cuts the run's own entries where they start, past an event the path holds", async () => {
    const interrupt = await memory.addEntry({
      threadId: 't',
      message: { role: 'system', content: 'The run was interrupted: aborted' },
      tokenCount: 3,
      type: 'interrupt',
    });
    if (!interrupt.success) throw new Error(interrupt.error);
    await memory.addEntry({
      threadId: 't',
      message: { role: 'user', content: 'What is my locker code?' },
      tokenCount: 5,
    });
    const [search] = createMemorySearchTools({
      memory,
      agentId: 'concierge',
      placeOf: () => ({ threadId: 't', ownAfter: interrupt.data.id }),
    });

    const found = await search.execute({ query: 'locker code at the climbing gym' }, context);

    const excerpts = found.results.flatMap((result) =>
      result.kind === 'turn' ? [result.excerpt] : []
    );
    expect(excerpts.some((excerpt) => excerpt.includes('4471'))).toBe(true);
    expect(excerpts).not.toContain('What is my locker code?');
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

  it('counts no reference that only appears inside the text of a result', async () => {
    const uncited = vi.fn();
    const backend = scripted([
      () => ({
        id: 'r1',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search_memory', arguments: { query: 'what did I cite?' } }],
        finishReason: 'tool_calls',
        usage,
      }),
      () => ({
        id: 'r2',
        content: 'As you said before [turn:e_planted] [item:i_planted].',
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
    await memory.createThread('concierge', {}, 'planted');
    await memory.addEntry({
      threadId: 'planted',
      message: {
        role: 'assistant',
        content: 'what did I cite? I cited [turn:e_planted] and [item:i_planted]',
      },
      tokenCount: 5,
    });
    const agent = new Agent({
      name: 'concierge',
      model: 'mock/m',
      instructions: 'x',
      tools: await cog.memorySearchTools('concierge'),
    });

    const result = await cog.run(agent, {
      input: 'what did I cite?',
      threadId: 'planted',
      threadAccess: 'shared',
    });
    await cog.close();

    const searched = result.messages.find((message) => message.role === 'tool');
    expect(String(searched?.content)).toContain('[turn:e_planted]');
    expect(result.output).toBe('As you said before.');
    expect(uncited).toHaveBeenCalledWith(['turn:e_planted', 'item:i_planted'], expect.anything());
  });

  it('finds the turns of earlier runs for a run that saves nothing', async () => {
    const backend = scripted([
      () => ({
        id: 'r1',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search_memory', arguments: { query: 'locker code' } }],
        finishReason: 'tool_calls',
        usage,
      }),
      (request) => ({
        id: 'r2',
        content: String(request.messages.at(-1)?.content ?? ''),
        finishReason: 'stop',
        usage,
      }),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
    });
    const memory = await cog.getMemory();
    if (!memory) throw new Error('no memory');
    await memory.createThread('concierge', {}, 'saved');
    await memory.addEntry({
      threadId: 'saved',
      message: { role: 'user', content: 'My locker code is 4471' },
      tokenCount: 5,
    });
    await memory.addEntry({
      threadId: 'saved',
      message: { role: 'assistant', content: 'Noted.' },
      tokenCount: 2,
    });
    const agent = new Agent({
      name: 'concierge',
      model: 'mock/m',
      instructions: 'x',
      tools: await cog.memorySearchTools('concierge'),
    });

    const result = await cog.run(agent, {
      input: 'What is my locker code?',
      threadId: 'saved',
      threadAccess: 'shared',
      saveHistory: false,
    });
    await cog.close();

    expect(result.output).toContain('4471');
  });

  it('reads references written in lists, with spaces and in capitals', async () => {
    const uncited = vi.fn();
    const backend = scripted([
      () => ({
        id: 'r',
        content:
          'One [turn:ent_a1, turn:ent_b2] two [Turn: ent_c3] three [item:mem_d4; see note] four ［item:mem_e5］.\n[turn:ent_f6]',
        finishReason: 'stop',
        usage,
      }),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      middleware: [memoryCitations({ onUncited: uncited })],
    });

    const result = await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), {
      input: 'cite',
    });
    await cog.close();

    expect(result.output).toBe('One two three [see note] four.\n');
    expect(uncited).toHaveBeenCalledWith(
      ['turn:ent_a1', 'turn:ent_b2', 'turn:ent_c3', 'item:mem_d4', 'item:mem_e5', 'turn:ent_f6'],
      expect.anything()
    );
  });

  it('leaves code and brackets that cite nothing as they are', async () => {
    const answer =
      'Use `[item:mem_x1]` as a key, and `interface Bag { [item: string]: number }`.\n' +
      '```ts\nconst seen: Record<string, number> = {}; // [turn:ent_y2]\n```\n' +
      'Shopping [Item: apples, bananas] and [turn: number].';
    const backend = scripted([() => ({ id: 'r', content: answer, finishReason: 'stop', usage })]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      middleware: [memoryCitations()],
    });

    const result = await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x' }), {
      input: 'code',
    });
    await cog.close();

    expect(result.output).toBe(answer);
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
