import { describe, it, expect } from 'vitest';
import type { MemoryEntry, Message, NewMemoryItem } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryItems } from '../memory-items';
import { analyzeQuery, timeExpressionOf } from '../retrieval/query';
import { diversify, fuse, lexicalScore, recencyBias, wordsOf } from '../retrieval/rank';
import { MemoryRetriever } from '../retrieval/retriever';

const anchor = new Date('2026-03-15T12:00:00Z');

describe('analyzeQuery', () => {
  it('does not search for small talk', () => {
    for (const input of ['thanks!', 'ok', 'Hello', 'got it.', '  ']) {
      expect(analyzeQuery(input, anchor).retrieve).toBe(false);
    }
    expect(analyzeQuery('What did I order?', anchor).retrieve).toBe(true);
  });

  it('tells the kind of question', () => {
    expect(analyzeQuery('When did I start the course?', anchor).type).toBe('temporal');
    expect(analyzeQuery('How many books did I buy in total?', anchor).type).toBe('aggregate');
    expect(analyzeQuery('Where do I live now?', anchor).type).toBe('update');
    expect(analyzeQuery('Can you recommend a restaurant?', anchor).type).toBe('preference');
    expect(analyzeQuery('What is the name of my dog?', anchor).type).toBe('general');
  });

  it('resolves the time a question names from the date it is asked on', () => {
    const lastWeek = analyzeQuery('What did I cook last week?', anchor);
    expect(lastWeek.type).toBe('temporal');
    expect(lastWeek.time).toMatchObject({
      start: new Date('2026-03-02T00:00:00Z'),
      end: new Date('2026-03-09T00:00:00Z'),
      precision: 'week',
    });
    expect(timeExpressionOf('three days ago')).toEqual({
      text: 'three days ago',
      relative: { unit: 'day', amount: -3 },
    });
    expect(timeExpressionOf('back in May 2024')).toEqual({ text: 'may 2024', date: '2024-05' });
    expect(timeExpressionOf('in 2023')).toEqual({ text: '2023', date: '2023' });
    expect(timeExpressionOf('last friday')).toEqual({
      text: 'last friday',
      weekday: { day: 'friday', amount: -1 },
    });
    expect(timeExpressionOf('my favourite color')).toBeUndefined();
    const today = { year: 2026, month: 3, day: 15 };
    expect(timeExpressionOf('on March 9', today)).toEqual({ text: 'march 9', date: '2026-03-09' });
    expect(timeExpressionOf('the 2nd of May', today)).toEqual({
      text: '2nd of may',
      date: '2025-05-02',
    });
    expect(timeExpressionOf('in May', today)).toEqual({ text: 'may', date: '2025-05' });
  });
});

describe('ranking', () => {
  it('fuses channels by weighted reciprocal rank', () => {
    const fused = fuse([
      { channel: 'a', ids: ['x', 'y'], weight: 1 },
      { channel: 'b', ids: ['y', 'z'], weight: 2 },
    ]);
    expect([...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)).toEqual([
      'y',
      'z',
      'x',
    ]);
  });

  it('scores the share of terms a text holds, rare terms counting more', () => {
    const df = (term: string) => (term === 'dog' ? 10 : 1);
    expect(lexicalScore(['dog', 'rex'], 'my dog rex', df)).toBe(1);
    expect(lexicalScore(['dog', 'rex'], 'my dog', df)).toBeLessThan(0.1);
    expect(lexicalScore([], 'anything')).toBe(0);
  });

  it('leans toward recent turns without leaving old ones out', () => {
    expect(recencyBias(0)).toBe(1);
    expect(recencyBias(200)).toBeCloseTo(0.75);
    expect(recencyBias(1e9)).toBeCloseTo(0.5);
  });

  it('puts a near copy behind a different hit of a lower score', () => {
    const ranked = diversify([
      { id: 'a', score: 1, words: wordsOf('ana lives in porto with her dog') },
      { id: 'b', score: 0.95, words: wordsOf('ana lives in porto with her dog rex') },
      { id: 'c', score: 0.6, words: wordsOf('the meeting moved to friday') },
    ]);
    expect(ranked.map((candidate) => candidate.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('MemoryRetriever', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 2, day, 10));
  const entry = (id: string, role: 'user' | 'assistant', content: string, day: number) =>
    ({
      id,
      threadId: 't',
      message: { role, content } as Message,
      tokenCount: 0,
      createdAt: at(day),
    }) as MemoryEntry;
  const history = [
    entry('e0', 'user', 'I adopted a dog named Rex from the shelter', 1),
    entry('e1', 'assistant', 'Congratulations on adopting Rex!', 1),
    entry('e2', 'user', 'The weather is lovely today', 5),
    entry('e3', 'assistant', 'Enjoy the sunshine.', 5),
    entry('e4', 'user', 'I booked flights to Lisbon for the conference', 9),
    entry('e5', 'assistant', 'Have a great trip to Lisbon.', 9),
    entry('e6', 'user', 'Any tips for packing?', 14),
    entry('e7', 'assistant', 'Roll your clothes.', 14),
  ];

  it('finds a turn by its words and brings the question an answer replies to', async () => {
    const retrieval = await new MemoryRetriever().retrieve({
      input: 'What is the name of my dog?',
      anchor,
      history,
      held: new Set(['e6', 'e7']),
    });

    const first = retrieval.hits[0];
    expect(first?.kind).toBe('entry');
    if (first?.kind !== 'entry') return;
    expect(['e0', 'e1']).toContain(first.hit.entry.id);
    const ids = retrieval.hits.flatMap((hit) => (hit.kind === 'entry' ? [hit.hit.entry.id] : []));
    expect(ids).not.toContain('e6');
  });

  it('finds the turns of the time a question names', async () => {
    const retrieval = await new MemoryRetriever().retrieve({
      input: 'What did I do on March 9 2026?',
      anchor,
      history,
    });
    expect(retrieval.analysis.type).toBe('temporal');
    const top = retrieval.hits[0];
    expect(top?.kind === 'entry' && ['e4', 'e5'].includes(top.hit.entry.id)).toBe(true);
  });

  it('lets vectors in only above the absolute and the relative bar', async () => {
    const retrieval = await new MemoryRetriever().retrieve({
      input: 'something unrelated entirely',
      anchor,
      history,
      cosines: new Map([
        ['e2', 0.9],
        ['e4', 0.5],
        ['e6', 0.3],
      ]),
    });
    const vectorHits = retrieval.hits.flatMap((hit) =>
      hit.kind === 'entry' && hit.hit.channels.includes('vector') ? [hit.hit.entry.id] : []
    );
    expect(vectorHits).toEqual(['e2']);
  });

  it('skips small talk', async () => {
    const retrieval = await new MemoryRetriever().retrieve({ input: 'thanks!', anchor, history });
    expect(retrieval.hits).toEqual([]);
  });

  it('finds memory items by words, the entities named and the graph around them', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const items = new MemoryItems({ adapter });
    const scope = { agentId: 'a', userId: 'u1' };
    const said = (fields: Partial<NewMemoryItem> & Pick<NewMemoryItem, 'content'>) => ({
      kind: 'fact' as const,
      trust: 'user' as const,
      confidence: 0.9,
      scope,
      evidence: [],
      verified: true,
      saidAt: at(1),
      sessionAt: at(1),
      ...fields,
    });
    await items.write([
      said({ content: 'Rex is a golden retriever', subject: 'Rex', attribute: 'breed' }),
      said({ content: 'Rex sleeps in the kitchen with Ana', subject: 'Rex' }),
      said({ content: 'Ana works at Acme', subject: 'Ana', attribute: 'employer' }),
      said({ content: 'The user prefers window seats', kind: 'preference' }),
    ]);

    const retrieval = await new MemoryRetriever().retrieve({
      input: 'Tell me about Rex',
      anchor,
      history: [],
      items,
      itemAdapter: adapter,
      scope,
    });

    const found = retrieval.hits.flatMap((hit) => (hit.kind === 'item' ? [hit.hit] : []));
    expect(
      found
        .slice(0, 2)
        .map((hit) => hit.item.content)
        .sort()
    ).toEqual(['Rex is a golden retriever', 'Rex sleeps in the kitchen with Ana']);
    expect(found.some((hit) => hit.channels.includes('itemEntity'))).toBe(true);
    expect(found.some((hit) => hit.channels.includes('graph'))).toBe(true);
    const ana = found.find((hit) => hit.item.content === 'Ana works at Acme');
    expect(ana?.channels).toEqual(['graph']);
  });
});
