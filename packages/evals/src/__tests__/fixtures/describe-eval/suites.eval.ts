import { describe, expect, it } from 'vitest';
import { describeEval } from '../../../vitest';
import { EvalSuite } from '../../../eval-suite';
import type { EvalTarget } from '../../../eval-suite';
import { Dataset } from '../../../datasets';
import { exactMatch } from '../../../metrics/deterministic';
import { threshold } from '../../../assertions';

const answers: Record<string, string> = { '2+2': '4', '3+3': '6', '4+4': '8', '5+5': '11' };
const expected: Record<string, string> = { ...answers, '5+5': '10' };

const arithmetic: EvalTarget = {
  fn: async (input) => {
    const answer = answers[input];
    if (answer === undefined) throw new Error(`no answer for ${input}`);
    return answer;
  },
};

function suite(inputs: string[], target: EvalTarget = arithmetic): EvalSuite {
  return new EvalSuite({
    dataset: Dataset.from(inputs.map((input) => ({ input, expected: expected[input] ?? '?' }))),
    target,
    metrics: [exactMatch()],
    assertions: [threshold('exactMatch', 1)],
    retries: 0,
  });
}

const passing = describeEval('passing', {
  suite: suite(['2+2', '3+3', '4+4']),
  run: { maxCases: 2 },
});

describeEval('failing case', { suite: suite(['2+2', 'unknown\ninput', '5+5']) });

describeEval('run failure', {
  suite: suite(['2+2', '3+3']),
  run: { signal: AbortSignal.abort(new Error('cancelled before start')) },
});

describeEval('timeout', {
  suite: suite(['2+2'], {
    fn: (_input, { signal }) =>
      new Promise<string>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('never answered')), 20_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      }),
  }),
  timeout: 300,
});

describe('result access', () => {
  it('reads the finished result', () => {
    const result = passing.result();
    expect(result.stats.total).toBe(2);
    expect(result.aggregated.exactMatch.mean).toBe(1);
  });
});
