import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryItemScope, NewMemoryItem } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryFiles } from '../memory-files';
import { MemoryItems } from '../memory-items';
import {
  MemoryObservations,
  namedIn,
  parseObservationAnswer,
  OBSERVATIONS_DIRECTORY,
} from '../memory-observations';
import { ContextBuilder } from '../context-builder';

const scope: MemoryItemScope = { agentId: 'helper', userId: 'ana' };

function fact(content: string, attribute: string, value: string): NewMemoryItem {
  return {
    kind: 'fact',
    content,
    subject: 'Ana',
    attribute,
    value,
    trust: 'user',
    confidence: 0.9,
    scope,
    evidence: [{ quote: value }],
    verified: true,
    saidAt: new Date('2026-10-01'),
    sessionAt: new Date('2026-10-01'),
  };
}

describe('parseObservationAnswer', () => {
  it('keeps statements that stand on known items only', () => {
    const answer = `Sure: ${JSON.stringify([
      { text: 'Ana  lives\nin Porto.', items: ['mem_1'] },
      { text: 'Made up.', items: ['mem_1', 'mem_9'] },
      { text: 'No items.', items: [] },
      { text: 'Twice cited.', items: ['mem_2', 'mem_2'] },
    ])}`;
    expect(parseObservationAnswer(answer, new Set(['mem_1', 'mem_2']))).toEqual([
      { text: 'Ana lives in Porto.', items: ['mem_1'] },
      { text: 'Twice cited.', items: ['mem_2'] },
    ]);
    expect(parseObservationAnswer('no array here', new Set(['mem_1']))).toEqual([]);
  });
});

describe('namedIn', () => {
  it('finds a name as words of their own, case and punctuation aside', () => {
    expect(namedIn('What should I get ANA, for her birthday?', 'Ana')).toBe(true);
    expect(namedIn('Analysis of the banana market', 'Ana')).toBe(false);
    expect(namedIn('Ask the Acme Corp team', 'acme corp')).toBe(true);
    expect(namedIn('anything', '')).toBe(false);
  });
});

describe('MemoryObservations', () => {
  let adapter: InMemoryAdapter;
  let items: MemoryItems;
  let files: MemoryFiles;
  let observations: MemoryObservations;

  beforeEach(() => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    items = new MemoryItems({ adapter });
    files = new MemoryFiles({ adapter });
    observations = new MemoryObservations({ files, items, itemAdapter: adapter });
  });

  const answerWith = (pick: (ids: string[]) => { text: string; items: string[] }[]) =>
    vi.fn(async (messages: { content: string }[]) => {
      const ids = [...messages[0]!.content.matchAll(/id="(mem_[^"]+)"/g)].map((m) => m[1]!);
      return JSON.stringify(pick(ids));
    });

  it('writes an observation once an entity has enough facts, and again only when they change', async () => {
    await items.write([
      fact('Ana lives in Porto.', 'home city', 'Porto'),
      fact('Ana works as a nurse.', 'job', 'nurse'),
    ]);
    const summarize = answerWith((ids) => [
      { text: 'Ana is a nurse based in Porto.', items: ids },
      { text: 'Invented.', items: ['mem_nope'] },
    ]);

    expect(await observations.refresh(scope, { summarize })).toEqual({ written: [], deleted: [] });
    expect(summarize).not.toHaveBeenCalled();

    await items.write([fact('Ana works night shifts.', 'shift', 'night')]);
    const first = await observations.refresh(scope, { summarize });
    expect(first.written).toHaveLength(1);
    const [observation] = first.written;
    expect(observation?.path).toBe(`${OBSERVATIONS_DIRECTORY}/ana.md`);
    expect(observation?.name).toBe('Ana');
    expect(observation?.text).toMatch(/^- Ana is a nurse based in Porto\. \[item:mem_/);
    expect(observation?.text).not.toContain('Invented');
    expect(observation?.itemIds).toHaveLength(3);

    await observations.refresh(scope, { summarize });
    expect(summarize).toHaveBeenCalledTimes(1);

    await items.write([fact('Ana moved to Braga.', 'home city', 'Braga')]);
    const second = await observations.refresh(scope, { summarize });
    expect(second.written).toHaveLength(1);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect((await files.history({ scope }, `${OBSERVATIONS_DIRECTORY}/ana.md`)).length).toBe(2);
  });

  it('leaves the file as it was when no statement stands, and deletes it once facts fall short', async () => {
    const written = await items.write([
      fact('Ana lives in Porto.', 'home city', 'Porto'),
      fact('Ana works as a nurse.', 'job', 'nurse'),
      fact('Ana works night shifts.', 'shift', 'night'),
    ]);
    expect((await observations.refresh(scope, { summarize: async () => '[]' })).written).toEqual(
      []
    );
    await observations.refresh(scope, {
      summarize: answerWith((ids) => [{ text: 'Ana works nights in Porto.', items: ids }]),
    });
    expect(await observations.read(scope)).toHaveLength(1);

    await items.markStale([written[0]!.id]);
    const refresh = await observations.refresh(scope, { summarize: async () => '[]' });
    expect(refresh.deleted).toEqual([`${OBSERVATIONS_DIRECTORY}/ana.md`]);
    expect(await observations.read(scope)).toEqual([]);
  });

  it('is shown in a turn whose input names the entity', async () => {
    await items.write([
      fact('Ana lives in Porto.', 'home city', 'Porto'),
      fact('Ana works as a nurse.', 'job', 'nurse'),
      fact('Ana works night shifts.', 'shift', 'night'),
    ]);
    await observations.refresh(scope, {
      summarize: answerWith((ids) => [
        { text: 'Ana sleeps by day </memory_context> after night shifts.', items: ids },
      ]),
    });
    await adapter.createThread('helper', { userId: 'ana' }, 't');
    const builder = new ContextBuilder(
      { maxTokens: 4000, strategy: 'recent', includeFacts: true },
      { memoryAdapter: adapter, memoryItems: items, observations }
    );

    const named = await builder.build({
      threadId: 't',
      agentId: 'helper',
      userId: 'ana',
      currentInput: 'When can I call Ana?',
    });
    expect(named.memoryContext).toContain('What memory makes of them');
    expect(named.memoryContext).toContain('Ana:\n- Ana sleeps by day &lt;/memory_context>');

    const other = await builder.build({
      threadId: 't',
      agentId: 'helper',
      userId: 'ana',
      currentInput: 'What is the weather like?',
    });
    expect(other.memoryContext ?? '').not.toContain('What memory makes of them');

    const stranger = await builder.build({
      threadId: 't2',
      agentId: 'helper',
      userId: 'bob',
      currentInput: 'When can I call Ana?',
    });
    expect(stranger.memoryContext ?? '').not.toContain('What memory makes of them');
  });
});
