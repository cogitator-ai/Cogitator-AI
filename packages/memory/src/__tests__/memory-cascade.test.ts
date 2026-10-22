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
import { InMemoryEmbeddingAdapter } from '../adapters/memory-embedding';

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
      source: 'inferred',
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

  it('takes the replies past an event between the message and its answer', async () => {
    const asked = await say('My pin is 0000.');
    const change = unwrap(
      await memory.addEntry({
        threadId: 't',
        type: 'model_change',
        message: { role: 'system', content: 'model changed' },
        tokenCount: 1,
        event: { from: 'a', to: 'b' },
      })
    );
    const answer = await say('Your pin 0000 is noted.', 'assistant');
    const next = await say('Thanks.');

    const report = await cascade.deleteEntries([asked.id], who);

    expect(report.entries.deleted.sort()).toEqual([asked.id, change.id, answer.id].sort());
    expect(unwrap(await memory.getEntry(next.id))).not.toBeNull();
  });

  it('deletes the vectors of the entries that go, with no message index listening', async () => {
    const embeddings = new InMemoryEmbeddingAdapter();
    const withVectors = new MemoryCascade({ memory, items: memory, embeddings });
    const [card] = entries;
    unwrap(
      await embeddings.addEmbedding({
        sourceId: card!.id,
        sourceType: 'message',
        vector: [1, 0],
        content: 'My card number is 4111.',
      })
    );

    await withVectors.deleteEntries([card!.id], who);

    const left = unwrap(await embeddings.search({ vector: [1, 0], limit: 5, threshold: 0 }));
    expect(left).toEqual([]);
  });

  it('leaves the entries in place when the cascade fails, so it can be run again', async () => {
    const [card] = entries;
    const [cardItem] = await items.write([item('Ana has card 4111.', [card!.id])]);
    const find = memory.findItems.bind(memory);
    let failing = true;
    memory.findItems = async (filter) =>
      failing ? { success: false, error: 'store down' } : find(filter);

    await expect(cascade.deleteEntries([card!.id], who)).rejects.toThrow('store down');
    expect(unwrap(await memory.getEntry(card!.id))).not.toBeNull();

    failing = false;
    const report = await cascade.deleteEntries([card!.id], who);
    expect(report.items.purged).toEqual([cardItem!.id]);
    expect(unwrap(await memory.getEntry(card!.id))).toBeNull();
  });

  it('leaves a thread that stands at the target as it is', async () => {
    const [, , porto, after] = entries;
    const [other] = await items.write([item('Ana said got it.', [after!.id])]);
    unwrap(await memory.rewind('t', porto!.id));

    const report = await cascade.rewind('t', porto!.id, who);

    expect(report.items.stale).toEqual([]);
    expect((await items.get(other!.id))?.status).toBe('active');
  });

  it('drops a summary whose first kept entry went before what it covers', async () => {
    const [secret, , kept] = entries;
    unwrap(
      await memory.addEntry({
        threadId: 't',
        type: 'compaction',
        message: { role: 'user', content: 'Summary: the card is 4111.' },
        tokenCount: 4,
        event: {
          firstKeptEntryId: kept!.id,
          lastCompactedEntryId: entries[1]!.id,
          compacted: 2,
          summarized: true,
        },
      })
    );
    await cascade.deleteEntries([kept!.id], { ...who, keepReplies: true });
    const report = await cascade.deleteEntries([secret!.id], { ...who, keepReplies: true });
    expect(report.summaries).toHaveLength(1);
  });

  it('forgets the copies of an entry in the threads forked from its thread', async () => {
    const [card] = entries;
    unwrap(await memory.updateThread('t', { pausedRun: { version: 1, threadId: 't' } }));
    const fork = unwrap(await memory.forkThread('t', entries[3]!.id, 'f'));
    expect(fork.metadata.pausedRun).toBeUndefined();
    const forked = unwrap(await memory.getEntries({ threadId: 'f' }));
    expect(JSON.stringify(forked)).toContain('4111');

    const report = await cascade.deleteEntries([card!.id], who);

    const left = unwrap(await memory.getEntries({ threadId: 'f' }));
    expect(JSON.stringify(left)).not.toContain('4111');
    expect(report.threadsChanged.sort()).toEqual(['f', 't']);
  });

  it('fails before it changes anything when a fork cannot be read, and skips a fork deleted', async () => {
    const [card] = entries;
    unwrap(await memory.forkThread('t', entries[3]!.id, 'f'));
    unwrap(await memory.forkThread('t', entries[3]!.id, 'gone'));
    unwrap(await memory.deleteThread('gone'));
    const read = memory.getEntries.bind(memory);
    memory.getEntries = async (options) =>
      options.threadId === 'f' ? { success: false, error: 'fork unreadable' } : read(options);

    await expect(cascade.deleteEntries([card!.id], who)).rejects.toThrow('fork unreadable');
    expect(unwrap(await memory.getEntry(card!.id))).not.toBeNull();

    memory.getEntries = read;
    await cascade.deleteEntries([card!.id], who);
    expect(JSON.stringify(unwrap(await memory.getEntries({ threadId: 'f' })))).not.toContain(
      '4111'
    );
  });

  it('redacts the playbook of a user it forgets, the rules of no lesson too', async () => {
    const [card] = entries;
    const [lesson] = await items.write([item('Never ask for card numbers.', [card!.id], 'lesson')]);
    await files.put(
      { scope, author: 'system' },
      PLAYBOOK_PATH,
      playbookFile({ rules: [`Never ask for cards. [lesson:${lesson!.id}]`, 'Ana prefers mail.'] })
    );

    await cascade.deleteUser('ana', who);

    const history = await files.history({ scope }, PLAYBOOK_PATH);
    expect(history.filter((version) => version.content?.includes('Ana prefers mail'))).toEqual([]);
  });

  it('forgets what a user wrote in a thread of someone else, leaving the rest', async () => {
    unwrap(
      await memory.createThread('helper', { userId: 'ana', memoryUserIds: ['ana', 'bob'] }, 'group')
    );
    unwrap(
      await memory.addEntry({
        threadId: 'group',
        message: { role: 'user', content: 'Ana here.' },
        tokenCount: 2,
        metadata: { userId: 'ana' },
      })
    );
    const bob = unwrap(
      await memory.addEntry({
        threadId: 'group',
        message: { role: 'user', content: 'Bob here, my phone is 555-0199.' },
        tokenCount: 5,
        metadata: { userId: 'bob' },
      })
    );

    const report = await cascade.deleteUser('bob', who);

    expect(report.entries.deleted).toContain(bob.id);
    const left = unwrap(await memory.getEntries({ threadId: 'group' }));
    expect(left.map((entry) => entry.message.content)).toEqual(['Ana here.']);
  });

  it('still redacts the observation that names an item when made again after a failure', async () => {
    const [card] = entries;
    const [cardFact] = await items.write([item('Ana has card 4111.', [card!.id])]);
    await files.put(
      { scope, author: 'system' },
      `${OBSERVATIONS_DIRECTORY}/ana.md`,
      `# Ana\n<!-- memory observation: entity ent_x items 0123456789abcdef -->\n\n- Card 4111 [item:${cardFact!.id}]\n`
    );
    const redactVersions = memory.redactFileVersions.bind(memory);
    let failing = true;
    memory.redactFileVersions = async (ids, redaction) =>
      failing ? { success: false, error: 'store down' } : redactVersions(ids, redaction);

    await expect(cascade.deleteEntries([card!.id], who)).rejects.toThrow('store down');
    failing = false;
    await cascade.deleteEntries([card!.id], who);

    const history = await files.history({ scope }, `${OBSERVATIONS_DIRECTORY}/ana.md`);
    expect(history.filter((version) => version.content?.includes('4111'))).toEqual([]);
    expect(await items.get(cardFact!.id)).toBeNull();
  });

  it('purges an item written from the entries while the cascade ran', async () => {
    const [card] = entries;
    const remove = memory.deleteEntry.bind(memory);
    let late: string | undefined;
    memory.deleteEntry = async (entryId) => {
      if (entryId === card!.id && late === undefined) {
        [late] = (await items.write([item('Late: card 4111.', [card!.id])])).map((one) => one.id);
      }
      return remove(entryId);
    };

    const report = await cascade.deleteEntries([card!.id], who);

    expect(report.items.purged).toContain(late);
    expect(await items.get(late!)).toBeNull();
  });

  it('keeps the path of a file another branch still holds text of', async () => {
    const [first, second, , last] = entries;
    const branchA = {
      threadId: 't',
      pathIds: new Set([first!.id, second!.id]),
      entryId: second!.id,
    };
    const branchB = {
      threadId: 't',
      pathIds: new Set(entries.map((entry) => entry.id)),
      entryId: last!.id,
    };
    await files.create({ scope, place: branchA }, '/memories/plan.md', 'branch A plan');
    const onA = await files.read({ scope, place: branchA }, '/memories/plan.md');
    await files.put({ scope, place: branchB }, '/memories/plan.md', 'branch B plan', onA!.sha256);

    await cascade.deleteEntries([last!.id], who);

    expect((await files.read({ scope, place: branchA }, '/memories/plan.md'))?.content).toBe(
      'branch A plan'
    );
  });

  it('marks nothing stale when the store refuses the rewind', async () => {
    const [, , porto, after] = entries;
    const [cut] = await items.write([item('Ana said got it.', [after!.id])]);
    const rewind = memory.rewind.bind(memory);
    memory.rewind = async () => ({ success: false, error: 'not on the active branch' });

    await expect(cascade.rewind('t', porto!.id, who)).rejects.toThrow('not on the active branch');

    expect((await items.get(cut!.id))?.status).toBe('active');
    memory.rewind = rewind;
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
    expect(observation).toBeUndefined();
    const kept = await files.history({ scope }, `${OBSERVATIONS_DIRECTORY}/ana.md`);
    expect(kept.filter((version) => version.content?.includes('4111'))).toEqual([]);
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
      source: 'inferred',
      metadata: { userId: 'ana' },
    });

    const report = await cascade.deleteUser('ana', who);

    expect(report.threads).toEqual(['t']);
    expect(unwrap(await memory.getThread('t'))).toBeNull();
    expect(report.items.purged.length).toBeGreaterThanOrEqual(1);
    expect(await items.query({ scope: { agentId: 'helper', userId: 'bob' } })).toHaveLength(1);
    expect(await items.query({ scope })).toEqual([]);
    expect(report.entities.length).toBeGreaterThanOrEqual(1);
    expect(await files.read({ scope }, '/memories/notes.md')).toBeUndefined();
    const history = await files.history({ scope }, '/memories/notes.md');
    expect(history.filter((version) => version.content?.includes('4111'))).toEqual([]);
    expect(facts.facts.size).toBe(0);
  });
});
