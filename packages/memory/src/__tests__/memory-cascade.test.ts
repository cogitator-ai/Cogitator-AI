import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  Fact,
  FactAdapter,
  MemoryEntry,
  MemoryItemScope,
  MemoryResult,
  NewMemoryItem,
} from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryItems } from '../memory-items';
import { MemoryFiles } from '../memory-files';
import { MemoryCascade } from '../memory-cascade';
import { OBSERVATIONS_DIRECTORY } from '../memory-observations';
import { PLAYBOOK_PATH, parsePlaybook, playbookFile } from '../memory-consolidation';
import { SQLiteGraphAdapter } from '../knowledge-graph/sqlite-graph-adapter';

const scope: MemoryItemScope = { agentId: 'helper', userId: 'ana' };
const who = { agentIds: ['helper'] };

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/** A fact store kept in a map, enough for a cascade */
class MapFacts implements FactAdapter {
  readonly facts = new Map<string, Fact>();
  async addFact(fact: Omit<Fact, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryResult<Fact>> {
    const made: Fact = {
      ...fact,
      id: `fact_${this.facts.size}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.facts.set(made.id, made);
    return { success: true, data: made };
  }
  async getFacts(agentId: string): Promise<MemoryResult<Fact[]>> {
    return {
      success: true,
      data: [...this.facts.values()].filter((fact) => fact.agentId === agentId),
    };
  }
  async updateFact(factId: string, updates: Partial<Fact>): Promise<MemoryResult<Fact>> {
    const fact = { ...this.facts.get(factId)!, ...updates };
    this.facts.set(factId, fact);
    return { success: true, data: fact };
  }
  async deleteFact(factId: string): Promise<MemoryResult<void>> {
    this.facts.delete(factId);
    return { success: true, data: undefined };
  }
  async searchFacts(): Promise<MemoryResult<Fact[]>> {
    return { success: true, data: [] };
  }
}

describe('MemoryCascade', () => {
  let memory: InMemoryAdapter;
  let items: MemoryItems;
  let files: MemoryFiles;
  let graph: SQLiteGraphAdapter;
  let facts: MapFacts;
  let cascade: MemoryCascade;
  let entries: MemoryEntry[];

  const say = async (content: string, role: 'user' | 'assistant' = 'user') =>
    unwrap(await memory.addEntry({ threadId: 't', message: { role, content }, tokenCount: 5 }));

  function item(
    content: string,
    entryIds: string[],
    kind: NewMemoryItem['kind'] = 'fact'
  ): NewMemoryItem {
    return {
      kind,
      content,
      subject: 'Ana',
      trust: 'user',
      confidence: 0.9,
      scope,
      evidence: entryIds.map((entryId) => ({ entryId, quote: content })),
      verified: true,
      status: 'active',
      saidAt: new Date('2026-10-01'),
      sessionAt: new Date('2026-10-01'),
    };
  }

  beforeEach(async () => {
    memory = new InMemoryAdapter({ provider: 'memory' });
    items = new MemoryItems({ adapter: memory });
    files = new MemoryFiles({ adapter: memory });
    graph = new SQLiteGraphAdapter({ path: ':memory:' });
    await graph.initialize();
    facts = new MapFacts();
    cascade = new MemoryCascade({ memory, items: memory, files: memory, graph, facts });
    unwrap(await memory.createThread('helper', { userId: 'ana' }, 't'));
    entries = [
      await say('My card number is 4111.'),
      await say('Noted.', 'assistant'),
      await say('I live in Porto.'),
      await say('Got it.', 'assistant'),
    ];
  });

  afterEach(async () => {
    await graph.close?.();
  });

  it('deletes entries with the summaries, items, facts and graph that stand on them', async () => {
    const [card, , porto] = entries;
    unwrap(
      await memory.addEntry({
        threadId: 't',
        type: 'compaction',
        message: { role: 'user', content: 'Summary: card 4111, lives in Porto.' },
        tokenCount: 8,
        event: { firstKeptEntryId: porto!.id, compacted: 2, summarized: true },
      })
    );
    const [onlyCard, both, onlyPorto] = await items.write([
      item('Ana has card 4111.', [card!.id]),
      item('Ana told about her card and city.', [card!.id, porto!.id]),
      item('Ana lives in Porto.', [porto!.id]),
    ]);
    await facts.addFact({
      agentId: 'helper',
      content: 'card 4111',
      category: 'fact',
      confidence: 1,
      source: 'extracted',
      evidence: [{ entryId: card!.id, quote: 'card' }],
    });
    const node = unwrap(
      await graph.addNode({
        agentId: 'helper',
        type: 'concept',
        name: 'card 4111',
        aliases: [],
        properties: {},
        confidence: 1,
        source: 'extracted',
        evidence: [{ entryId: card!.id, quote: 'card' }],
      })
    );

    const report = await cascade.deleteEntries([card!.id], who);

    expect(report.entries.deleted.sort()).toEqual([card!.id, entries[1]!.id].sort());
    expect(report.summaries).toHaveLength(1);
    expect(report.items.purged).toEqual([onlyCard!.id]);
    expect(report.items.trimmed).toEqual([both!.id]);
    expect(await items.get(onlyCard!.id)).toBeNull();
    expect((await items.get(both!.id))?.evidence.map((piece) => piece.entryId)).toEqual([
      porto!.id,
    ]);
    expect((await items.get(onlyPorto!.id))?.evidence).toHaveLength(1);
    expect(facts.facts.size).toBe(0);
    expect(report.graph.nodes).toEqual([node.id]);
    const left = unwrap(await memory.getEntries({ threadId: 't', types: 'all' }));
    expect(left.some((entry) => entry.type === 'compaction')).toBe(false);
    expect(JSON.stringify(left)).not.toContain('4111');
  });

  it('leaves the replies alone when asked to', async () => {
    const [card, noted] = entries;
    const report = await cascade.deleteEntries([card!.id], { ...who, keepReplies: true });
    expect(report.entries.deleted).toEqual([card!.id]);
    expect(unwrap(await memory.getEntry(noted!.id))).not.toBeNull();
  });

  it('keeps a summary that covers none of what went', async () => {
    const [card, , porto] = entries;
    unwrap(
      await memory.addEntry({
        threadId: 't',
        type: 'compaction',
        message: { role: 'user', content: 'Summary: the card.' },
        tokenCount: 4,
        event: { firstKeptEntryId: porto!.id, compacted: 2, summarized: true },
      })
    );
    const report = await cascade.deleteEntries([entries[3]!.id], who);
    expect(report.summaries).toEqual([]);
    expect(card).toBeDefined();
  });

  it('redacts entries in place and takes away what stands on them', async () => {
    const [card] = entries;
    const [onlyCard] = await items.write([item('Ana has card 4111.', [card!.id])]);

    const report = await cascade.redactEntries(
      [card!.id],
      { at: new Date(), reason: 'asked' },
      who
    );

    expect(report.entries.redacted).toEqual([card!.id, entries[1]!.id]);
    expect(report.items.purged).toEqual([onlyCard!.id]);
    const read = unwrap(await memory.getEntry(card!.id));
    expect(read?.message.content).toBe('[redacted]');
    expect(unwrap(await memory.getEntries({ threadId: 't' }))).toHaveLength(4);
  });

  it('redacts the observations and playbook versions that name what went, keeping the other rules', async () => {
    const [card, , porto] = entries;
    const [cardFact, portoFact] = await items.write([
      item('Ana has card 4111.', [card!.id]),
      item('Ana lives in Porto.', [porto!.id]),
    ]);
    const [cardLesson, portoLesson] = await items.write([
      item('Asking for the card number was a mistake.', [card!.id], 'lesson'),
      item('Asking the city first helped.', [porto!.id], 'lesson'),
    ]);
    const system = { scope, author: 'system' as const };
    await files.put(
      system,
      `${OBSERVATIONS_DIRECTORY}/ana.md`,
      `# Ana\n<!-- memory observation: entity ent_x items 0123456789abcdef -->\n\n- Ana pays with card 4111 [item:${cardFact!.id}] [item:${portoFact!.id}]\n`
    );
    await files.put(
      system,
      PLAYBOOK_PATH,
      playbookFile({
        rules: [
          `Never ask for card numbers. [lesson:${cardLesson!.id}]`,
          `Ask the city first. [lesson:${portoLesson!.id}]`,
        ],
      })
    );

    const report = await cascade.deleteEntries([card!.id], who);

    expect(report.playbookRules).toBe(1);
    const playbook = await files.read({ scope }, PLAYBOOK_PATH);
    expect(parsePlaybook(playbook!.content).rules).toEqual([
      `Ask the city first. [lesson:${portoLesson!.id}]`,
    ]);
    const history = await files.history({ scope }, PLAYBOOK_PATH);
    expect(history.filter((version) => version.content?.includes('card'))).toEqual([]);
    const observation = await files.read({ scope }, `${OBSERVATIONS_DIRECTORY}/ana.md`);
    expect(observation?.content).toBe('[redacted]');
    const { MemoryObservations } = await import('../memory-observations');
    const observations = new MemoryObservations({ files, items, itemAdapter: memory });
    await items.write([
      item('Ana works as a nurse.', [porto!.id]),
      item('Ana swims.', [porto!.id]),
    ]);
    const refreshed = await observations.refresh(scope, {
      summarize: async (messages) => {
        const ids = [...String(messages[0]?.content).matchAll(/id="(mem_[^"]+)"/g)].map(
          (m) => m[1]
        );
        return JSON.stringify([{ text: 'Ana lives in Porto and works as a nurse.', items: ids }]);
      },
    });
    expect(refreshed.written.map((written) => written.path)).toEqual([
      `${OBSERVATIONS_DIRECTORY}/ana.md`,
    ]);
    expect(report.fileVersions.length).toBeGreaterThanOrEqual(2);
  });

  it('marks as stale what stood only on the branch a rewind cut off', async () => {
    const [, , porto, after] = entries;
    const [kept, cut] = await items.write([
      item('Ana lives in Porto.', [porto!.id]),
      item('Ana said got it.', [after!.id]),
    ]);

    const report = await cascade.rewind('t', porto!.id, who);

    expect(report.items.stale).toEqual([cut!.id]);
    expect((await items.get(cut!.id))?.metadata?.staleBecause).toMatchObject({ reason: 'rewound' });
    expect((await items.get(kept!.id))?.status).toBe('active');
    expect(unwrap(await memory.getEntry(after!.id))).not.toBeNull();
  });

  it('forgets a user: threads, items, entities, files and owned facts', async () => {
    const [card] = entries;
    await items.write([
      item('Ana has card 4111.', [card!.id]),
      { ...item('Bob likes tea.', []), scope: { agentId: 'helper', userId: 'bob' } },
    ]);
    await files.create({ scope }, '/memories/notes.md', 'Ana card 4111');
    await facts.addFact({
      agentId: 'helper',
      content: 'Ana prefers mail',
      category: 'preference',
      confidence: 1,
      source: 'extracted',
      metadata: { userId: 'ana' },
    });

    const report = await cascade.deleteUser('ana', who);

    expect(report.threads).toEqual(['t']);
    expect(unwrap(await memory.getThread('t'))).toBeNull();
    expect(report.items.purged.length).toBeGreaterThanOrEqual(1);
    expect(await items.query({ scope: { agentId: 'helper', userId: 'bob' } })).toHaveLength(1);
    expect(await items.query({ scope })).toEqual([]);
    expect(report.entities.length).toBeGreaterThanOrEqual(1);
    expect((await files.read({ scope }, '/memories/notes.md'))?.content).toBe('[redacted]');
    expect(facts.facts.size).toBe(0);
  });
});
