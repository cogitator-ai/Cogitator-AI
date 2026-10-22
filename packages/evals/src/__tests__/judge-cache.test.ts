import { describe, it, expect, vi } from 'vitest';
import { bindJudgeContext, judgeContextFor, relevance } from '../metrics/llm-judge';
import { JudgeConfigSchema } from '../schema';
import type { JudgeCache, JudgeCogitator } from '../schema';
import type { EvalCaseResult } from '../metrics/types';

const caseResult = (input: string, output: string): EvalCaseResult => ({
  case: { input },
  output,
  duration: 1,
});

function judgeRuntime(delay = 0) {
  let inFlight = 0;
  let peak = 0;
  const run = vi.fn(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delay));
    inFlight--;
    return { output: '{"score": 0.8, "reasoning": "fine"}', usage: { cost: 0.01 } };
  });
  return { cogitator: { run } as unknown as JudgeCogitator, run, peak: () => peak };
}

describe('judge cache and concurrency', () => {
  it('judges an answer once with cache on, later verdicts costing nothing', async () => {
    const judge = judgeRuntime();
    const config = JudgeConfigSchema.parse({ model: 'm', cache: true });
    const metric = bindJudgeContext(relevance(), judgeContextFor(judge.cogitator, config));

    const first = await metric(caseResult('q', 'a'));
    const again = await metric(caseResult('q', 'a'));
    const other = await metric(caseResult('q', 'b'));

    expect(judge.run).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ score: 0.8, usage: { cost: 0.01 } });
    expect(again.score).toBe(0.8);
    expect(again.usage).toBeUndefined();
    expect(other.usage).toMatchObject({ cost: 0.01 });
  });

  it('keeps verdicts in a cache of your own and never caches an unreadable one', async () => {
    const store = new Map<string, string>();
    const cache: JudgeCache = {
      get: (key) => store.get(key),
      set: (key, verdict) => void store.set(key, verdict),
    };
    const run = vi
      .fn()
      .mockResolvedValueOnce({ output: 'no verdict here' })
      .mockResolvedValue({ output: '{"score": 1}' });
    const config = JudgeConfigSchema.parse({ model: 'm', cache });
    const metric = bindJudgeContext(
      relevance(),
      judgeContextFor({ run } as unknown as JudgeCogitator, config)
    );

    await metric(caseResult('q', 'a'));
    await metric(caseResult('q', 'a'));
    await metric(caseResult('q', 'a'));

    expect(run).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(1);
  });

  it('runs at most judge.concurrency verdicts at once', async () => {
    const judge = judgeRuntime(20);
    const config = JudgeConfigSchema.parse({ model: 'm', concurrency: 2 });
    const metric = bindJudgeContext(relevance(), judgeContextFor(judge.cogitator, config));

    await Promise.all(Array.from({ length: 6 }, (_, at) => metric(caseResult(`q${at}`, 'a'))));

    expect(judge.run).toHaveBeenCalledTimes(6);
    expect(judge.peak()).toBe(2);
  });

  it('judges a prompt asked again while its verdict is still being written only once', async () => {
    const store = new Map<string, string>();
    const cache: JudgeCache = {
      get: (key) => store.get(key),
      set: async (key, verdict) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        store.set(key, verdict);
      },
    };
    const judge = judgeRuntime();
    const config = JudgeConfigSchema.parse({ model: 'm', cache });
    const metric = bindJudgeContext(relevance(), judgeContextFor(judge.cogitator, config));

    const first = metric(caseResult('q', 'a'));
    await vi.waitFor(() => expect(judge.run).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = metric(caseResult('q', 'a'));

    expect((await Promise.all([first, second])).map((s) => s.score)).toEqual([0.8, 0.8]);
    expect(judge.run).toHaveBeenCalledTimes(1);
  });

  it('judges again over a cached verdict it cannot read', async () => {
    const store = new Map<string, string>();
    const cache: JudgeCache = {
      get: (key) => store.get(key),
      set: (key, verdict) => void store.set(key, verdict),
    };
    const judge = judgeRuntime();
    const config = JudgeConfigSchema.parse({ model: 'm', cache });
    const metric = bindJudgeContext(relevance(), judgeContextFor(judge.cogitator, config));
    await metric(caseResult('q', 'a'));
    const [key] = store.keys();
    store.set(key!, 'garbage');

    const rejudged = await metric(caseResult('q', 'a'));

    expect(judge.run).toHaveBeenCalledTimes(2);
    expect(rejudged.score).toBe(0.8);
    expect(store.get(key!)).toBe('{"score": 0.8, "reasoning": "fine"}');
  });

  it('frees the slot of a judge call that failed', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue({ output: '{"score": 1}' });
    const config = JudgeConfigSchema.parse({ model: 'm', concurrency: 1 });
    const metric = bindJudgeContext(
      relevance(),
      judgeContextFor({ run } as unknown as JudgeCogitator, config)
    );

    const scores = await Promise.allSettled(
      ['q0', 'q1', 'q2'].map((input) => metric(caseResult(input, 'a')))
    );

    expect(run).toHaveBeenCalledTimes(3);
    expect(scores.filter((s) => s.status === 'fulfilled')).toHaveLength(scores.length);
    expect(scores.map((s) => (s.status === 'fulfilled' ? s.value.score : undefined))).toEqual([
      0, 1, 1,
    ]);
  });

  it('judges on when the cache fails to read or write, and treats a null as a miss', async () => {
    const warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const broken: JudgeCache = {
      get: () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
    };
    const nulls = { get: async () => null, set: async () => undefined } as unknown as JudgeCache;

    for (const cache of [broken, nulls]) {
      const judge = judgeRuntime();
      const metric = bindJudgeContext(
        relevance(),
        judgeContextFor(judge.cogitator, JudgeConfigSchema.parse({ model: 'm', cache }))
      );
      expect(await metric(caseResult('q', 'a'))).toMatchObject({ score: 0.8 });
      expect(judge.run).toHaveBeenCalledTimes(1);
    }
    expect(warnings).toHaveBeenCalledTimes(2);
    warnings.mockRestore();
  });

  it('judges a prompt asked several times at once only once', async () => {
    const judge = judgeRuntime(20);
    const metric = bindJudgeContext(
      relevance(),
      judgeContextFor(judge.cogitator, JudgeConfigSchema.parse({ model: 'm', cache: true }))
    );

    const scores = await Promise.all([1, 2, 3].map(() => metric(caseResult('q', 'same'))));

    expect(judge.run).toHaveBeenCalledTimes(1);
    expect(scores.map((one) => one.score)).toEqual([0.8, 0.8, 0.8]);
    expect(scores.filter((one) => one.usage !== undefined)).toHaveLength(1);
  });
});
