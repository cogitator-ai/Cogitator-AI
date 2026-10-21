import { describe, it, expect, beforeEach } from 'vitest';
import type { Fact, FactAdapter, Message } from '@cogitator-ai/types';
import { ContextAssembler, type AssemblyBlock } from '../context-assembler';
import { ContextBuilder, withoutTurnContext } from '../context-builder';
import { InMemoryAdapter } from '../adapters/memory';
import { countEntryTokens } from '../token-counter';

const block = (tokens: number, text?: string): AssemblyBlock<string> => ({
  value: text ?? `${tokens}`,
  tokens,
  ...(text !== undefined && { text }),
  sourceId: text ?? `${tokens}`,
});

describe('ContextAssembler', () => {
  it('gives a partition the room another one does not need', async () => {
    const assembly = await new ContextAssembler().assemble(1000, [
      { partition: 'facts', blocks: [block(300), block(300), block(300)] },
      { partition: 'recent', blocks: [block(50)] },
    ]);

    expect(assembly.tokens.facts).toBe(900);
    expect(assembly.tokens.recent).toBe(50);
    expect(assembly.dropped).toEqual([]);
  });

  it('shares what is left among hungry partitions by their shares', async () => {
    const assembly = await new ContextAssembler({
      facts: { share: 0.2 },
      recall: { share: 0.2 },
    }).assemble(1000, [
      { partition: 'facts', blocks: Array.from({ length: 20 }, () => block(50)) },
      { partition: 'recall', blocks: Array.from({ length: 20 }, () => block(50)) },
      { partition: 'recent', blocks: Array.from({ length: 20 }, () => block(50)) },
    ]);

    expect(assembly.tokens.facts).toBe(200);
    expect(assembly.tokens.recall).toBe(200);
    expect(assembly.tokens.recent).toBe(600);
    expect(assembly.used).toBeLessThanOrEqual(1000);
    expect(assembly.dropped.every((dropped) => dropped.reason === 'budget')).toBe(true);
  });

  it('keeps required partitions before anything else gets room', async () => {
    const assembly = await new ContextAssembler().assemble(500, [
      { partition: 'summaries', blocks: [block(400)] },
      { partition: 'recent', blocks: [block(200), block(50)] },
    ]);

    expect(assembly.tokens.summaries).toBe(400);
    expect(assembly.kept.recent?.map((kept) => kept.tokens)).toEqual([50]);
    expect(assembly.dropped).toEqual([
      { partition: 'recent', reason: 'oversized', tokens: 200, sourceId: '200' },
    ]);
  });

  it('leaves out what a more lasting partition says already', async () => {
    const assembly = await new ContextAssembler().assemble(1000, [
      { partition: 'pinned', blocks: [block(10, 'The user lives in Lisbon, Portugal.')] },
      {
        partition: 'facts',
        blocks: [block(10, 'the user lives in lisbon portugal'), block(10, 'Likes tea')],
      },
      { partition: 'recall', blocks: [block(10, 'Likes tea'), block(10, 'Works at a bakery')] },
    ]);

    expect(assembly.kept.facts?.map((kept) => kept.text)).toEqual(['Likes tea']);
    expect(assembly.kept.recall?.map((kept) => kept.text)).toEqual(['Works at a bakery']);
    expect(assembly.dropped.map((dropped) => [dropped.partition, dropped.reason])).toEqual([
      ['facts', 'duplicate'],
      ['recall', 'duplicate'],
    ]);
  });

  it('keeps a block that says more than one before it, and checks only blocks that stayed', async () => {
    const assembly = await new ContextAssembler().assemble(1000, [
      { partition: 'facts', blocks: [block(2000, 'The user lives in Lisbon, Portugal')] },
      {
        partition: 'recall',
        blocks: [
          block(10, 'The user lives in Lisbon, Portugal'),
          block(20, 'The user lives in Lisbon, Portugal and works at the harbour'),
        ],
      },
    ]);

    expect(assembly.kept.recall?.map((kept) => kept.text)).toEqual([
      'The user lives in Lisbon, Portugal',
      'The user lives in Lisbon, Portugal and works at the harbour',
    ]);
  });

  it('shares only what the system prompt leaves', async () => {
    const assembly = await new ContextAssembler({
      facts: { share: 0.5 },
      recall: { share: 0 },
      index: { share: 0 },
      brief: { share: 0 },
    }).assemble(1000, [
      { partition: 'system', blocks: [block(600)] },
      { partition: 'facts', blocks: Array.from({ length: 10 }, () => block(50)) },
      { partition: 'recent', blocks: Array.from({ length: 10 }, () => block(50)) },
    ]);

    expect(assembly.tokens.facts).toBe(200);
    expect(assembly.tokens.recent).toBe(200);
  });

  it('counts an input larger than the room in full, leaving the rest nothing', async () => {
    const assembly = await new ContextAssembler().assemble(1000, [
      { partition: 'system', blocks: [block(100)] },
      { partition: 'final', blocks: [block(950)] },
      { partition: 'recent', blocks: [block(10)] },
    ]);

    expect(assembly.tokens.final).toBe(950);
    expect(assembly.tokens.recent).toBe(0);
  });

  it('gives what the shares cannot place to the partitions still hungry', async () => {
    const assembly = await new ContextAssembler({ recall: { share: 0.85 } }).assemble(10000, [
      { partition: 'recall', blocks: [block(500)] },
      { partition: 'recent', blocks: Array.from({ length: 100 }, () => block(50)) },
    ]);

    expect(assembly.tokens.recall).toBe(500);
    expect(assembly.tokens.recent).toBe(5000);
  });

  it('shares the room a required partition could not use', async () => {
    const assembly = await new ContextAssembler().assemble(1000, [
      { partition: 'summaries', blocks: [block(2600)] },
      { partition: 'recent', blocks: Array.from({ length: 6 }, () => block(50)) },
    ]);

    expect(assembly.tokens.summaries).toBe(0);
    expect(assembly.tokens.recent).toBe(300);
  });

  it('tells words apart when it looks for repeats', async () => {
    const assembly = await new ContextAssembler().assemble(1000, [
      {
        partition: 'pinned',
        blocks: [block(10, 'The user works at the bankruptcy court in Lisbon')],
      },
      { partition: 'facts', blocks: [block(10, 'The user works at the bank')] },
    ]);

    expect(assembly.kept.facts?.map((kept) => kept.text)).toEqual(['The user works at the bank']);
  });

  it('refuses shares that add up to more than 1', () => {
    expect(() => new ContextAssembler({ facts: { share: 0.7 }, recall: { share: 0.7 } })).toThrow(
      /add up to/
    );
  });

  it('refuses a share outside 0 to 1', () => {
    expect(() => new ContextAssembler({ facts: { share: 1.5 } })).toThrow(/share from 0 to 1/);
  });
});

describe('ContextBuilder on the assembler', () => {
  let adapter: InMemoryAdapter;
  const threadId = 't';

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
    await adapter.createThread('agent', {}, threadId);
  });

  async function add(message: Message, type?: 'compaction') {
    const added = await adapter.addEntry({
      threadId,
      message,
      tokenCount: 1,
      ...(type && { type, event: { firstKeptEntryId: null, compacted: 4, summarized: true } }),
    });
    if (!added.success) throw new Error(added.error);
    return added.data;
  }

  it('goes on past a tool output too large for the room, keeping a note in its place', async () => {
    await add({ role: 'user', content: 'find the report' });
    await add({ role: 'assistant', content: 'searching' });
    const big = await add({
      role: 'tool',
      content: 'row '.repeat(3000),
      toolCallId: 'c1',
      name: 'search',
    });
    await add({ role: 'assistant', content: 'found it' });
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 600 },
      { memoryAdapter: adapter }
    );

    const result = await builder.build({ threadId, agentId: 'agent' });

    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(String(result.messages[2]?.content)).toMatch(/left out of the context/);
    expect(result.dropped.blocks).toEqual([
      expect.objectContaining({ partition: 'recent', reason: 'oversized', sourceId: big.id }),
    ]);
    expect(countEntryTokens(big)).toBeGreaterThan(600);
    expect(result.tokenCount).toBeLessThan(600);
    expect(result.dropped.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('builds without the graph when cutting it down fails', async () => {
    const nodes = ['a', 'b'].map((id) => ({
      id,
      agentId: 'agent',
      name: id,
      type: 'concept' as const,
      aliases: [],
      properties: {},
      confidence: 1,
      source: 'user' as const,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    let calls = 0;
    const graph = {
      buildContext: async () => {
        calls++;
        if (calls > 1) throw new Error('graph store down');
        return { nodes, edges: [], formattedContext: 'graph '.repeat(400), tokenCount: 2000 };
      },
    };
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 600, includeGraphContext: true },
      { memoryAdapter: adapter, graphContextBuilder: graph as never }
    );

    const result = await builder.build({ threadId, agentId: 'agent', currentInput: 'who' });

    expect(result.graphContext).toBeUndefined();
    expect(result.errors?.map((error) => error.source)).toEqual(['graph']);
  });

  it('always keeps the summary of compacted history', async () => {
    await add({ role: 'system', content: '[Conversation summary]\nearlier talk' }, 'compaction');
    for (let i = 0; i < 20; i++) {
      await add({ role: 'user', content: `turn ${i} ${'words '.repeat(40)}` });
    }
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 400 },
      { memoryAdapter: adapter }
    );

    const result = await builder.build({ threadId, agentId: 'agent' });

    expect(result.messages[0]?.content).toBe('[Conversation summary]\nearlier talk');
    expect(result.partitions.summaries).toBeGreaterThan(0);
    expect(result.dropped.blocks.every((dropped) => dropped.partition === 'recent')).toBe(true);
  });

  it('puts what lasts first, marks the end of history and sends facts with the turn', async () => {
    await add({ role: 'user', content: 'hello' });
    await add({ role: 'assistant', content: 'hi' });
    const facts: Fact[] = [
      {
        id: 'f1',
        agentId: 'agent',
        content: 'Prefers short answers',
        category: 'preference',
        confidence: 1,
        source: 'user',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
    const factAdapter = {
      getFacts: async () => ({ success: true as const, data: facts }),
    } as unknown as FactAdapter;
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 2000, includeFacts: true },
      { memoryAdapter: adapter, factAdapter }
    );

    const result = await builder.build({
      threadId,
      agentId: 'agent',
      systemPrompt: 'Be kind.',
      pinned: ['The user is Ana.'],
      index: 'Memory holds 2 facts.',
      brief: 'Ana asked about trains yesterday.',
      currentInput: 'and today?',
    });

    expect(result.messages).toEqual([
      {
        role: 'system',
        content: 'Be kind.\n\nThe user is Ana.\n\nMemory holds 2 facts.',
      },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', cacheBreakpoint: true },
      { role: 'user', content: result.memoryContext },
    ]);
    expect(result.memoryContext).toMatch(/^<memory_context>\n\nContext for this turn/);
    expect(result.memoryContext).toMatch(/<\/memory_context>$/);
    expect(withoutTurnContext(`${result.memoryContext}\n\nand today?`)).toBe('and today?');
    expect(result.memoryContext).toContain('Ana asked about trains yesterday.');
    expect(result.memoryContext).toContain('Known facts:\n- Prefers short answers');
    expect(result.partitions.final).toBeGreaterThan(0);
  });

  it('marks the end of the history and of the turn before it', async () => {
    for (const content of ['q1', 'a1', 'q2', 'a2']) {
      await add({ role: content.startsWith('q') ? 'user' : 'assistant', content });
    }
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 2000 },
      { memoryAdapter: adapter }
    );

    const result = await builder.build({ threadId, agentId: 'agent' });

    expect(result.messages.map((m) => [m.content, m.cacheBreakpoint === true])).toEqual([
      ['q1', false],
      ['a1', true],
      ['q2', false],
      ['a2', true],
    ]);
  });

  it('takes the reserve for the answer from the options when given', async () => {
    for (let i = 0; i < 10; i++) await add({ role: 'user', content: `m${i} ${'x '.repeat(20)}` });
    const builder = new ContextBuilder(
      { strategy: 'recent', maxTokens: 200 },
      { memoryAdapter: adapter }
    );

    const reserved = await builder.build({ threadId, agentId: 'agent' });
    const unreserved = await builder.build({ threadId, agentId: 'agent', reserveTokens: 0 });

    expect(unreserved.metadata.includedMessageCount).toBeGreaterThan(
      reserved.metadata.includedMessageCount
    );
  });
});
