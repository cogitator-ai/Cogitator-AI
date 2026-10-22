import { describe, it, expect } from 'vitest';
import { toolCalls, trajectory, toolCallMatches, trajectoryScore } from '../metrics/tool-calls';
import {
  retrievalRecall,
  retrievalPrecision,
  retrievalMRR,
  ragSearchPassages,
} from '../metrics/retrieval';
import { deepEqual, isSubset, maxMatching, passageMatches } from '../metrics/matching';
import type { EvalCase } from '../schema';
import type { EvalCaseResult, EvalToolCall, Passage } from '../metrics/types';

function call(name: string, args: Record<string, unknown> = {}, id = name): EvalToolCall {
  return { id, name, arguments: args };
}

function withCalls(
  expectedToolCalls: EvalCase['expectedToolCalls'],
  calls?: EvalToolCall[]
): EvalCaseResult {
  return {
    case: { input: 'q', expectedToolCalls },
    output: 'a',
    duration: 1,
    ...(calls && { toolCalls: calls }),
  };
}

function withPassages(
  expectedPassages: string[] | undefined,
  retrieved?: Passage[]
): EvalCaseResult {
  return {
    case: { input: 'q', expectedPassages },
    output: 'a',
    duration: 1,
    ...(retrieved && { retrieved }),
  };
}

describe('matching helpers', () => {
  it('deepEqual compares objects and arrays structurally', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
  });

  it('isSubset requires expected keys only, arrays item by item', () => {
    expect(isSubset({ city: 'Paris' }, { city: 'Paris', units: 'c' })).toBe(true);
    expect(isSubset({ city: 'Paris', units: 'f' }, { city: 'Paris', units: 'c' })).toBe(false);
    expect(isSubset({ q: { lang: 'en' } }, { q: { lang: 'en', n: 3 } })).toBe(true);
    expect(isSubset({ ids: [1, 2] }, { ids: [1, 2, 3] })).toBe(false);
    expect(isSubset({ missing: undefined }, {})).toBe(false);
  });

  it('maxMatching finds the largest one-to-one pairing, not a greedy one', () => {
    const left = ['ab', 'a'];
    const right = ['a', 'b'];
    const pairs = maxMatching(left, right, (l, r) => l.includes(r));
    expect(pairs.size).toBe(2);
    expect(pairs.get(1)).toBe(0);
    expect(pairs.get(0)).toBe(1);
  });

  it('passageMatches by id, by equal text, or by containment of three words or more', () => {
    const passage = { id: 'doc-1', content: 'The  Eiffel Tower is in PARIS.' };
    expect(passageMatches(passage, 'doc-1')).toBe(true);
    expect(passageMatches(passage, 'eiffel tower is in paris')).toBe(true);
    expect(passageMatches({ content: 'Tower in Paris' }, 'The tower in paris is tall')).toBe(true);
    expect(passageMatches({ content: 'Paris' }, 'paris')).toBe(true);
    expect(passageMatches(passage, 'doc-2')).toBe(false);
    expect(passageMatches({ content: '   ' }, 'anything')).toBe(false);
  });

  it('sets punctuation aside and matches whole words only', () => {
    expect(passageMatches({ content: 'Paris.' }, 'Paris')).toBe(true);
    expect(passageMatches({ content: 'Book early.' }, 'book early')).toBe(true);
    expect(passageMatches({ content: 'The capital is Parisville' }, 'capital is paris')).toBe(
      false
    );
    expect(passageMatches({ content: 'Yes, the capital is Paris!' }, 'capital is paris')).toBe(
      true
    );
  });

  it('never matches a short id or a single word as a part of a longer text', () => {
    expect(passageMatches({ id: 'c7', content: 'Chunk 1 talks about towers' }, '1')).toBe(false);
    expect(passageMatches({ content: 'Paris' }, 'Paris is in France. Rome is in Italy.')).toBe(
      false
    );
    expect(passageMatches({ content: 'The tower is in Paris' }, 'tower')).toBe(false);
  });
});

describe('toolCalls()', () => {
  it('scores 1 when the calls match the expected ones with argument subsets', async () => {
    const result = await toolCalls()(
      withCalls(
        [{ name: 'search', arguments: { q: 'paris' } }, { name: 'answer' }],
        [call('search', { q: 'paris', limit: 5 }), call('answer', { text: 'x' })]
      )
    );
    expect(result).toMatchObject({ name: 'toolCalls', score: 1, details: undefined });
    expect(result.metadata).toEqual({ precision: 1, recall: 1, f1: 1, matched: 2 });
  });

  it('scores the F1 of the multiset match and lists missing and unexpected calls', async () => {
    const result = await toolCalls()(
      withCalls(
        [{ name: 'search' }, { name: 'search' }, { name: 'book' }],
        [call('search', {}, '1'), call('cancel', {}, '2')]
      )
    );
    const precision = 1 / 2;
    const recall = 1 / 3;
    expect(result.score).toBeCloseTo((2 * precision * recall) / (precision + recall));
    expect(result.details).toBe('missing search, book | unexpected cancel({})');
  });

  it('scores recall or precision when asked', async () => {
    const data = withCalls([{ name: 'a' }, { name: 'b' }], [call('a'), call('c'), call('d')]);
    expect((await toolCalls({ score: 'recall' })(data)).score).toBe(0.5);
    expect((await toolCalls({ score: 'precision' })(data)).score).toBeCloseTo(1 / 3);
  });

  it('compares arguments exactly, by subset or not at all', async () => {
    const data = withCalls(
      [{ name: 'weather', arguments: { city: 'Paris' } }],
      [call('weather', { city: 'Paris', units: 'c' })]
    );
    expect((await toolCalls({ arguments: 'exact' })(data)).score).toBe(0);
    expect((await toolCalls({ arguments: 'subset' })(data)).score).toBe(1);
    expect(
      (
        await toolCalls({ arguments: 'ignore' })(
          withCalls([{ name: 'weather', arguments: { city: 'Rome' } }], [call('weather', {})])
        )
      ).score
    ).toBe(1);
  });

  it('scores 0 without expected tool calls, like exactMatch without expected', async () => {
    expect(await toolCalls()(withCalls(undefined, [call('a')]))).toEqual({
      name: 'toolCalls',
      score: 0,
      details: 'no expected tool calls provided',
    });
  });

  it('scores 1 when no calls were expected and none made, 0 when some were', async () => {
    expect((await toolCalls()(withCalls([], []))).score).toBe(1);
    expect((await toolCalls()(withCalls([]))).score).toBe(1);
    expect((await toolCalls()(withCalls([], [call('a')]))).score).toBe(0);
    expect((await toolCalls()(withCalls([{ name: 'a' }]))).score).toBe(0);
  });

  it('takes a custom name and rejects unknown options', () => {
    expect(toolCalls({ name: 'calls' }).metricName).toBe('calls');
    expect(() => toolCalls({ score: 'mean' as 'f1' })).toThrow(
      "toolCalls score must be one of 'f1'"
    );
    expect(() => toolCalls({ arguments: 'loose' as 'exact' })).toThrow('toolCalls arguments');
  });

  it('toolCallMatches treats an expected call without arguments as a name match', () => {
    expect(toolCallMatches({ name: 'a' }, call('a', { x: 1 }), 'exact')).toBe(true);
    expect(toolCallMatches({ name: 'a' }, call('b'), 'ignore')).toBe(false);
  });
});

describe('trajectory()', () => {
  const expected = [{ name: 'search' }, { name: 'fetch' }, { name: 'answer' }];

  it('exact order scores 1 only for the same sequence', async () => {
    const same = withCalls(expected, [call('search'), call('fetch'), call('answer')]);
    const swapped = withCalls(expected, [call('fetch'), call('search'), call('answer')]);
    expect((await trajectory()(same)).score).toBe(1);
    const result = await trajectory()(swapped);
    expect(result.score).toBe(0);
    expect(result.details).toBe('expected [search, fetch, answer], got [fetch, search, answer]');
  });

  it('in-order scores the longest common subsequence over the longer sequence', async () => {
    const data = withCalls(expected, [call('search'), call('log'), call('answer'), call('fetch')]);
    expect((await trajectory({ order: 'in-order' })(data)).score).toBe(2 / 4);
  });

  it('any-order scores the multiset overlap over the longer sequence', async () => {
    const data = withCalls(expected, [
      call('answer'),
      call('fetch'),
      call('search'),
      call('search'),
    ]);
    expect((await trajectory({ order: 'any-order' })(data)).score).toBe(3 / 4);
  });

  it('handles empty sequences and a missing expectation', async () => {
    expect(trajectoryScore([], [], 'in-order')).toBe(1);
    expect(trajectoryScore([], [], 'exact')).toBe(1);
    expect(trajectoryScore([], ['a'], 'any-order')).toBe(0);
    expect((await trajectory()(withCalls(undefined, [call('a')]))).details).toBe(
      'no expected tool calls provided'
    );
  });

  it('rejects an unknown order', () => {
    expect(() => trajectory({ order: 'loose' as 'exact' })).toThrow('trajectory order');
  });
});

describe('retrieval metrics', () => {
  const retrieved: Passage[] = [
    { id: 'c1', content: 'Bananas are yellow.' },
    { id: 'c2', content: 'The Eiffel Tower is in Paris.' },
    { id: 'c3', content: 'Water boils at 100 C.' },
  ];

  it('retrievalRecall is the share of expected passages retrieved', async () => {
    const result = await retrievalRecall()(
      withPassages(['eiffel tower is in paris', 'c3', 'missing fact'], retrieved)
    );
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.details).toBe('not retrieved: "missing fact"');
  });

  it('retrievalPrecision is the share of retrieved passages expected', async () => {
    const result = await retrievalPrecision()(withPassages(['c2'], retrieved));
    expect(result.score).toBeCloseTo(1 / 3);
    expect(result.details).toBe('2 of 3 retrieved passages were not expected');
  });

  it('retrievalMRR is the reciprocal rank of the first expected passage', async () => {
    expect((await retrievalMRR()(withPassages(['c2'], retrieved))).score).toBe(0.5);
    expect((await retrievalMRR()(withPassages(['bananas are yellow'], retrieved))).score).toBe(1);
    expect((await retrievalMRR()(withPassages(['nope'], retrieved))).score).toBe(0);
  });

  it('never matches a short expected id as a part of a passage text', async () => {
    const result = await retrievalRecall()(
      withPassages(['c1'], [{ content: 'See c1 and c2 for the details.' }])
    );
    expect(result.score).toBe(0);
  });

  it('scores 0 without expected passages', async () => {
    for (const m of [retrievalRecall(), retrievalPrecision(), retrievalMRR()]) {
      expect(await m(withPassages(undefined, retrieved))).toEqual({
        name: m.metricName,
        score: 0,
        details: 'no expected passages provided',
      });
    }
  });

  it('scores 0 when nothing was retrieved, 1 when nothing was expected or retrieved', async () => {
    expect(await retrievalRecall()(withPassages(['x']))).toEqual({
      name: 'retrievalRecall',
      score: 0,
      details: 'nothing was retrieved',
    });
    expect((await retrievalPrecision()(withPassages([]))).score).toBe(1);
    expect((await retrievalMRR()(withPassages([], retrieved))).score).toBe(0);
  });

  it('takes custom names', () => {
    expect(retrievalRecall({ name: 'r' }).metricName).toBe('r');
    expect(retrievalPrecision().metricName).toBe('retrievalPrecision');
    expect(retrievalMRR().metricName).toBe('retrievalMRR');
  });
});

describe('ragSearchPassages()', () => {
  it('reads the results of a rag_search tool result', () => {
    const passages = ragSearchPassages({
      name: 'rag_search',
      result: {
        success: true,
        query: 'q',
        count: 2,
        results: [
          { chunkId: 'doc:0', documentId: 'doc', content: 'one', score: 0.9, source: 'a.txt' },
          { id: 'own', chunkId: 'doc:1', content: 'two', metadata: { page: 2 } },
          { content: 42 },
          'junk',
        ],
      },
    });
    expect(passages).toEqual([
      { id: 'doc:0', content: 'one', score: 0.9, source: 'a.txt' },
      { id: 'own', content: 'two' },
    ]);
  });

  it('returns nothing for other results', () => {
    expect(ragSearchPassages({ name: 'rag_search', result: { success: false, error: 'x' } })).toBe(
      undefined
    );
    expect(ragSearchPassages({ name: 'calc', result: 42 })).toBe(undefined);
    expect(ragSearchPassages({ name: 'calc', result: { results: 'nope' } })).toBe(undefined);
  });
});
