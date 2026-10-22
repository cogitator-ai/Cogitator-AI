import { describe, it, expect } from 'vitest';
import { evalMatchers } from '../matchers';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import { exactMatch } from '../metrics/deterministic';
import type { ScoredCaseResult } from '../metrics/types';

expect.extend(evalMatchers);

const result: ScoredCaseResult = {
  case: { input: 'weather in Paris then book' },
  output: 'done',
  duration: 1,
  toolCalls: [
    { id: '1', name: 'search', arguments: { q: 'paris', limit: 3 } },
    { id: '2', name: 'weather', arguments: { city: 'Paris', units: 'c' } },
    { id: '3', name: 'book', arguments: {} },
  ],
  retrieved: [
    { id: 'doc:0', content: 'Paris has mild springs.' },
    { content: 'Book early in summer.' },
  ],
  scores: [{ name: 'exactMatch', score: 0.5, details: 'close' }],
};

function failureOf(assertion: () => void): string {
  try {
    assertion();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the assertion passed');
}

describe('evalMatchers', () => {
  it('toHaveCalledTool checks the name and an argument subset', () => {
    expect(result).toHaveCalledTool('weather');
    expect(result).toHaveCalledTool('weather', { city: 'Paris' });
    expect(result).not.toHaveCalledTool('weather', { city: 'Rome' });
    expect(result).not.toHaveCalledTool('cancel');
    expect(failureOf(() => expect(result).toHaveCalledTool('cancel', { id: 1 }))).toBe(
      'expected the case to call cancel({"id":1}), it made search({"q":"paris","limit":3}), weather({"city":"Paris","units":"c"}), book({})'
    );
    expect(failureOf(() => expect(result).not.toHaveCalledTool('book'))).toContain(
      'expected the case not to call book'
    );
  });

  it('toFollowTrajectory checks the sequence in the given order', () => {
    expect(result).toFollowTrajectory(['search', 'weather', 'book']);
    expect(result).not.toFollowTrajectory(['search', 'book']);
    expect(result).toFollowTrajectory(['search', 'book'], { order: 'in-order' });
    expect(result).not.toFollowTrajectory(['book', 'search'], { order: 'in-order' });
    expect(result).toFollowTrajectory(['book', 'search'], { order: 'any-order' });
    expect(result).not.toFollowTrajectory(['book', 'book'], { order: 'any-order' });
    expect(failureOf(() => expect(result).toFollowTrajectory(['book']))).toBe(
      'expected the tool calls to follow [book] (exact), they were [search, weather, book]'
    );
  });

  it('toHaveRetrieved matches an id or a text', () => {
    expect(result).toHaveRetrieved('doc:0');
    expect(result).toHaveRetrieved('book early in');
    expect(result).not.toHaveRetrieved('book');
    expect(result).not.toHaveRetrieved('Rome');
    expect(failureOf(() => expect(result).toHaveRetrieved('Rome'))).toBe(
      'expected the case to retrieve "Rome", it retrieved 2 passage(s): doc:0, "Book early in summer."'
    );
    expect(
      failureOf(() => expect({ ...result, retrieved: undefined }).toHaveRetrieved('x'))
    ).toContain('it retrieved nothing');
  });

  it('toScoreAtLeast reads a case score or a suite mean', async () => {
    expect(result).toScoreAtLeast('exactMatch', 0.5);
    expect(result).not.toScoreAtLeast('exactMatch', 0.6);
    expect(failureOf(() => expect(result).toScoreAtLeast('exactMatch', 0.9))).toBe(
      'expected the exactMatch score of the case (close) to be at least 0.9, it is 0.5'
    );
    expect(failureOf(() => expect(result).toScoreAtLeast('missing', 0))).toContain(
      "the case has no score for 'missing', it has 'exactMatch'"
    );

    const suiteResult = await new EvalSuite({
      dataset: Dataset.from([
        { input: 'a', expected: 'a' },
        { input: 'b', expected: 'x' },
      ]),
      target: { fn: async (input) => input },
      metrics: [exactMatch()],
    }).run();
    expect(suiteResult).toScoreAtLeast('exactMatch', 0.5);
    expect(suiteResult).not.toScoreAtLeast('exactMatch', 0.75);
    expect(failureOf(() => expect(suiteResult).toScoreAtLeast('latency', 0))).toContain(
      "the suite has no metric 'latency', it has 'exactMatch'"
    );
  });

  it('rejects values that are not results', () => {
    expect(failureOf(() => expect('text').toHaveCalledTool('x'))).toContain(
      'toHaveCalledTool expects a case result'
    );
  });

  it('works as asymmetric matchers', () => {
    expect({ result }).toEqual({ result: expect.toHaveCalledTool('search', { q: 'paris' }) });
  });
});
