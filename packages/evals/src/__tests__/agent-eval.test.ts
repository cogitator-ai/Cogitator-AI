import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import type { EvalTargetContext } from '../eval-suite';
import { Dataset } from '../datasets';
import { EvalBuilder } from '../eval-builder';
import { toolCalls, trajectory } from '../metrics/tool-calls';
import { retrievalRecall } from '../metrics/retrieval';
import { metric } from '../metrics/custom';
import { cost, latency } from '../metrics/statistical';
import { githubSummary } from '../reporters/github';
import type { EvalCaseResult, MetricFn, MetricScore } from '../metrics/types';

interface RunOptions {
  input: string;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  threadId?: string;
  onToolResult?: (result: {
    callId: string;
    name: string;
    result: unknown;
    error?: string;
  }) => void;
}

interface FakeTurn {
  output: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolResults?: { callId: string; name: string; result: unknown; error?: string }[];
  cost?: number;
  fail?: string;
}

/** A cogitator whose runs answer from `answer`, reporting tool results through onToolResult */
function fakeCogitator(answer: (options: RunOptions, call: number) => FakeTurn) {
  let call = 0;
  const run = vi.fn(async (_agent: unknown, options: RunOptions) => {
    const turn = answer(options, call++);
    if (turn.fail) throw new Error(turn.fail);
    for (const r of turn.toolResults ?? []) options.onToolResult?.(r);
    return {
      output: turn.output,
      ...(turn.toolCalls && { toolCalls: turn.toolCalls }),
      ...(turn.cost !== undefined && {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: turn.cost, duration: 5 },
      }),
    };
  });
  return { run };
}

function namedMetric(name: string, score: (r: EvalCaseResult) => number): MetricFn {
  const fn = (async (r: EvalCaseResult): Promise<MetricScore> => ({
    name,
    score: score(r),
  })) as MetricFn;
  fn.metricName = name;
  return fn;
}

const ragResult = {
  success: true,
  results: [
    { chunkId: 'doc:0', documentId: 'doc', content: 'Paris is the capital of France.', score: 0.9 },
    { chunkId: 'doc:1', documentId: 'doc', content: 'Lyon is a city in France.', score: 0.4 },
  ],
};

describe('agent target data', () => {
  it('collects tool results, retrieved passages and tool calls', async () => {
    const cogitator = fakeCogitator(() => ({
      output: 'Paris',
      toolCalls: [{ id: 'c1', name: 'rag_search', arguments: { query: 'capital' } }],
      toolResults: [
        { callId: 'c1', name: 'rag_search', result: ragResult },
        { callId: 'c2', name: 'broken', result: undefined, error: 'tool failed' },
      ],
    }));
    const suite = new EvalSuite({
      dataset: Dataset.from([
        {
          input: 'capital of France?',
          expectedToolCalls: [{ name: 'rag_search' }],
          expectedPassages: ['paris is the capital'],
        },
      ]),
      target: { agent: {}, cogitator },
      metrics: [toolCalls(), trajectory(), retrievalRecall()],
    });

    const [result] = (await suite.run()).results;

    expect(result.toolResults).toEqual([
      { callId: 'c1', name: 'rag_search', result: ragResult },
      { callId: 'c2', name: 'broken', error: 'tool failed' },
    ]);
    expect(result.retrieved).toEqual([
      { id: 'doc:0', content: 'Paris is the capital of France.', score: 0.9 },
      { id: 'doc:1', content: 'Lyon is a city in France.', score: 0.4 },
    ]);
    expect(result.turns).toBeUndefined();
    expect(result.scores.map((s) => [s.name, s.score])).toEqual([
      ['toolCalls', 1],
      ['trajectory', 1],
      ['retrievalRecall', 1],
    ]);
    expect(cogitator.run.mock.calls[0][1].threadId).toBeUndefined();
  });

  it('reads passages with the target retrieval instead of the default', async () => {
    const cogitator = fakeCogitator(() => ({
      output: 'ok',
      toolResults: [
        { callId: 'c1', name: 'lookup', result: { hits: ['alpha', 'beta'] } },
        { callId: 'c2', name: 'rag_search', result: ragResult },
      ],
    }));
    const retrieval = vi.fn((r: { name: string; result: unknown }) =>
      r.name === 'lookup'
        ? (r.result as { hits: string[] }).hits.map((content, i) => ({ id: `h${i}`, content }))
        : undefined
    );
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'q' }]),
      target: { agent: {}, cogitator, retrieval },
    });

    const [result] = (await suite.run()).results;

    expect(result.retrieved).toEqual([
      { id: 'h0', content: 'alpha' },
      { id: 'h1', content: 'beta' },
    ]);
    expect(retrieval).toHaveBeenCalledTimes(2);
  });

  it('refuses a retrieval on a fn target', () => {
    expect(
      () =>
        new EvalSuite({
          dataset: Dataset.from([{ input: 'q' }]),
          target: { fn: async () => 'x', retrieval: () => undefined },
        })
    ).toThrow('Target retrieval reads tool results, so it needs an agent target');
  });

  it('hands the whole case result to a custom metric', async () => {
    const cogitator = fakeCogitator(() => ({
      output: 'done',
      toolCalls: [{ id: 'c1', name: 'rag_search', arguments: {} }],
      toolResults: [{ callId: 'c1', name: 'rag_search', result: ragResult }],
    }));
    const evaluate = vi.fn(() => ({ score: 1 }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'q' }]),
      target: { agent: {}, cogitator },
      metrics: [metric({ name: 'seen', evaluate })],
    });

    await suite.run();

    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCalls: [{ id: 'c1', name: 'rag_search', arguments: {} }],
        toolResults: [{ callId: 'c1', name: 'rag_search', result: ragResult }],
        retrieved: expect.arrayContaining([expect.objectContaining({ id: 'doc:0' })]),
        result: expect.objectContaining({ output: 'done' }),
      })
    );
  });
});

describe('multi-turn cases', () => {
  it('runs every turn of an agent case on one thread and sums over the turns', async () => {
    const cogitator = fakeCogitator((options, call) => ({
      output: `answer to ${options.input}`,
      toolCalls: [{ id: `c${call}`, name: `tool${call % 2}`, arguments: {} }],
      toolResults: [{ callId: `c${call}`, name: `tool${call % 2}`, result: call }],
      cost: 0.5,
    }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'hello', turns: ['and then?', 'bye'] }]),
      target: { agent: {}, cogitator },
      concurrency: 1,
    });

    const [result] = (await suite.run()).results;

    const threads = cogitator.run.mock.calls.map(([, options]) => options.threadId);
    expect(threads).toHaveLength(3);
    expect(new Set(threads).size).toBe(1);
    expect(threads[0]).toMatch(/^eval-/);
    expect(cogitator.run.mock.calls.map(([, options]) => options.input)).toEqual([
      'hello',
      'and then?',
      'bye',
    ]);
    expect(result.output).toBe('answer to bye');
    expect(result.toolCalls?.map((c) => c.name)).toEqual(['tool0', 'tool1', 'tool0']);
    expect(result.toolResults?.map((r) => r.result)).toEqual([0, 1, 2]);
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 6,
      totalTokens: 9,
      cost: 1.5,
      duration: 15,
    });
    expect(result.turns).toEqual([
      {
        input: 'hello',
        output: 'answer to hello',
        toolCalls: [{ id: 'c0', name: 'tool0', arguments: {} }],
      },
      {
        input: 'and then?',
        output: 'answer to and then?',
        toolCalls: [{ id: 'c1', name: 'tool1', arguments: {} }],
      },
      {
        input: 'bye',
        output: 'answer to bye',
        toolCalls: [{ id: 'c2', name: 'tool0', arguments: {} }],
      },
    ]);
  });

  it('gives each case and each retry a thread of its own', async () => {
    const cogitator = fakeCogitator((options, call) =>
      call === 1 ? { output: '', fail: 'flaky' } : { output: options.input }
    );
    const suite = new EvalSuite({
      dataset: Dataset.from([
        { input: 'a', turns: ['b'] },
        { input: 'c', turns: ['d'] },
      ]),
      target: { agent: {}, cogitator },
      concurrency: 1,
      retries: 1,
    });

    const { results } = await suite.run();

    expect(results.map((r) => r.error)).toEqual([undefined, undefined]);
    const threads = cogitator.run.mock.calls.map(([, options]) => options.threadId);
    expect(threads[0]).toBe(threads[1]);
    expect(threads[2]).not.toBe(threads[0]);
    expect(threads[2]).toBe(threads[3]);
    expect(threads[4]).toBe(threads[5]);
    expect(new Set(threads).size).toBe(3);
  });

  it('fails the case with the error of a failing turn and keeps the turns so far', async () => {
    const cogitator = fakeCogitator((options) =>
      options.input === 'second'
        ? { output: '', fail: 'model down', cost: 1 }
        : { output: 'first answer', cost: 0.25 }
    );
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'first', turns: ['second', 'third'] }]),
      target: { agent: {}, cogitator },
      metrics: [namedMetric('m', () => 1)],
    });

    const result = await suite.run();
    const [caseResult] = result.results;

    expect(caseResult.error).toBe('model down');
    expect(caseResult.output).toBe('');
    expect(caseResult.scores).toEqual([]);
    expect(caseResult.usage?.cost).toBe(0.25);
    expect(caseResult.turns).toEqual([
      { input: 'first', output: 'first answer' },
      { input: 'second', output: '', error: 'model down' },
    ]);
    expect(cogitator.run).toHaveBeenCalledTimes(2);
    expect(result.stats.errors).toBe(1);
  });

  it('calls a fn target once per turn with the turn and the history', async () => {
    const seen: Array<Pick<EvalTargetContext, 'turn' | 'history'>> = [];
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'one', turns: ['two', 'three'] }, { input: 'solo' }]),
      target: {
        fn: async (input, context) => {
          seen.push({ turn: context.turn, history: context.history });
          return input.toUpperCase();
        },
      },
      concurrency: 1,
    });

    const { results } = await suite.run();

    expect(seen).toEqual([
      { turn: 0, history: [] },
      { turn: 1, history: [{ input: 'one', output: 'ONE' }] },
      {
        turn: 2,
        history: [
          { input: 'one', output: 'ONE' },
          { input: 'two', output: 'TWO' },
        ],
      },
      { turn: 0, history: [] },
    ]);
    expect(results[0].output).toBe('THREE');
    expect(results[0].turns).toHaveLength(3);
    expect(results[1].turns).toBeUndefined();
  });

  it('fails a fn target case on its failing turn', async () => {
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'one', turns: ['two'] }]),
      target: {
        fn: async (input) => {
          if (input === 'two') throw new Error('no second answer');
          return 'ok';
        },
      },
    });

    const [result] = (await suite.run()).results;

    expect(result.error).toBe('no second answer');
    expect(result.turns).toEqual([
      { input: 'one', output: 'ok' },
      { input: 'two', output: '', error: 'no second answer' },
    ]);
  });
});

describe('trials', () => {
  it('runs each case several times, scores each trial and aggregates the per-case mean', async () => {
    const outputs = new Map<string, string[]>([
      ['a', ['yes', 'no', 'yes', 'yes']],
      ['b', ['no', 'no', 'no', 'no']],
    ]);
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
      target: { fn: async (input) => outputs.get(input)!.shift()! },
      metrics: [namedMetric('isYes', (r) => (r.output === 'yes' ? 1 : 0))],
      trials: 4,
      concurrency: 1,
    });

    const result = await suite.run();

    expect(result.results).toHaveLength(2);
    const [a, b] = result.results;
    expect(a.output).toBe('yes');
    expect(a.trials?.map((t) => t.output)).toEqual(['yes', 'no', 'yes', 'yes']);
    expect(a.trials?.map((t) => t.scores[0].score)).toEqual([1, 0, 1, 1]);
    expect(a.trials?.[0].trials).toBeUndefined();
    expect(a.scores).toEqual([{ name: 'isYes', score: 1 }]);
    expect(b.trials).toHaveLength(4);
    expect(result.aggregated.isYes.mean).toBeCloseTo((0.75 + 0) / 2);
    expect(result.aggregated.isYes.count).toBe(2);
    expect(result.stats.total).toBe(2);
  });

  it('counts the cost and metric errors of every trial', async () => {
    const cogitator = fakeCogitator(() => ({ output: 'x', cost: 0.1 }));
    const failing = (async () => {
      throw new Error('bad metric');
    }) as unknown as MetricFn;
    failing.metricName = 'failing';
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }]),
      target: { agent: {}, cogitator },
      metrics: [failing],
      trials: 3,
    });

    const { stats } = await suite.run();

    expect(stats.targetCost).toBeCloseTo(0.3);
    expect(stats.metricErrors).toBe(3);
  });

  it('keeps errored trials unscored and averages the others', async () => {
    let call = 0;
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }]),
      target: {
        fn: async () => {
          if (call++ === 1) throw new Error('flaky');
          return 'ok';
        },
      },
      metrics: [namedMetric('m', () => 0.5)],
      trials: 3,
      concurrency: 1,
    });

    const result = await suite.run();
    const [caseResult] = result.results;

    expect(caseResult.error).toBeUndefined();
    expect(caseResult.trials?.map((t) => t.error)).toEqual([undefined, 'flaky', undefined]);
    expect(result.aggregated.m.mean).toBe(0.5);
    expect(result.stats.errors).toBe(0);
  });

  it('respects the concurrency limit across trials', async () => {
    let running = 0;
    let peak = 0;
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }, { input: 'c' }]),
      target: {
        fn: async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
          return 'ok';
        },
      },
      trials: 3,
      concurrency: 2,
    });

    const progress: number[] = [];
    const withProgress = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
      target: { fn: async () => 'ok' },
      trials: 2,
      onProgress: (p) => progress.push(p.completed),
    });

    const result = await suite.run({ maxCases: 2 });
    await withProgress.run();

    expect(peak).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.trials?.length === 3)).toBe(true);
    expect(progress).toEqual([1, 2]);
  });

  it('stops scheduling trials once the run is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
      target: {
        fn: async () => {
          if (++calls === 2) controller.abort(new Error('stop'));
          return 'ok';
        },
      },
      trials: 5,
      concurrency: 1,
    });

    await expect(suite.run({ signal: controller.signal })).rejects.toThrow('stop');
    expect(calls).toBe(2);
  });

  it('rejects trials that are not a positive integer', () => {
    const base = { dataset: Dataset.from([{ input: 'a' }]), target: { fn: async () => 'ok' } };
    expect(() => new EvalSuite({ ...base, trials: 0 })).toThrow();
    expect(() => new EvalSuite({ ...base, trials: 1.5 })).toThrow();
  });

  it('is set by the builder', async () => {
    const suite = new EvalBuilder()
      .withDataset(Dataset.from([{ input: 'a' }]))
      .withTarget({ fn: async () => 'ok' })
      .withTrials(2)
      .build();
    const { results } = await suite.run();
    expect(results[0].trials).toHaveLength(2);
  });
});

describe('reports of agent runs', () => {
  it('keep tool calls, tool results, retrieved passages, turns and trials in the json report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-agent-report-'));
    try {
      const cogitator = fakeCogitator((options) => ({
        output: `re: ${options.input}`,
        toolCalls: [{ id: 'c1', name: 'rag_search', arguments: { query: options.input } }],
        toolResults: [{ callId: 'c1', name: 'rag_search', result: ragResult }],
      }));
      const suite = new EvalSuite({
        dataset: Dataset.from([{ input: 'hi', turns: ['more'] }]),
        target: { agent: {}, cogitator },
        metrics: [namedMetric('m', () => 1)],
        trials: 2,
      });

      const result = await suite.run();
      const path = join(dir, 'report');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      result.report(['json', 'console'], { path });
      const printed = log.mock.calls.map((args) => args.join(' ')).join('\n');
      log.mockRestore();

      const json = JSON.parse(readFileSync(`${path}.json`, 'utf-8')) as {
        results: Array<Record<string, unknown> & { trials: Array<Record<string, unknown>> }>;
      };
      const [reported] = json.results;
      expect(reported.toolCalls).toHaveLength(2);
      expect(reported.toolResults).toHaveLength(2);
      expect(reported.retrieved).toHaveLength(4);
      expect(reported.turns).toHaveLength(2);
      expect(reported.trials).toHaveLength(2);
      expect(reported.trials[1].scores).toEqual([{ name: 'm', score: 1 }]);
      expect(reported.trials[1].turns).toHaveLength(2);
      expect(printed).toContain('1 cases x 2 trials');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('aborting multi-turn cases', () => {
  it('starts no further turn of a fn target once the run is aborted', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async (input: string) => {
      controller.abort(new Error('stop'));
      return input;
    });
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'one', turns: ['two', 'three'] }]),
      target: { fn },
    });

    await expect(suite.run({ signal: controller.signal })).rejects.toThrow('stop');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('starts no further turn of an agent target once the run is aborted', async () => {
    const controller = new AbortController();
    const cogitator = fakeCogitator((options) => {
      controller.abort(new Error('stop'));
      return { output: options.input };
    });
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'one', turns: ['two', 'three'] }]),
      target: { agent: {}, cogitator },
    });

    await expect(suite.run({ signal: controller.signal })).rejects.toThrow('stop');
    expect(cogitator.run).toHaveBeenCalledTimes(1);
  });

  it('starts no further turn after the attempt timed out, keeping the turns so far', async () => {
    const fn = vi.fn(async (input: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return input;
    });
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'one', turns: ['two'] }]),
      target: { fn },
      timeout: 1000,
    });

    const [result] = (await suite.run()).results;

    expect(result.error).toBe('Timed out after 1000ms');
    expect(result.turns).toEqual([{ input: 'one', output: 'one' }]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('trials of agent cases', () => {
  it('gives every trial of a multi-turn case a thread of its own', async () => {
    const cogitator = fakeCogitator((options) => ({ output: options.input }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a', turns: ['b'] }]),
      target: { agent: {}, cogitator },
      trials: 2,
      concurrency: 1,
    });

    await suite.run();

    const threads = cogitator.run.mock.calls.map(([, options]) => options.threadId);
    expect(threads).toHaveLength(4);
    expect(threads[0]).toBe(threads[1]);
    expect(threads[2]).toBe(threads[3]);
    expect(threads[0]).not.toBe(threads[2]);
  });

  it('reports a case whose first trial errored by the first trial that answered', async () => {
    let call = 0;
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }]),
      target: {
        fn: async () => {
          if (call++ === 0) throw new Error('first failed');
          return 'ok';
        },
      },
      metrics: [namedMetric('m', () => 0.8)],
      trials: 3,
      concurrency: 1,
    });

    const result = await suite.run();
    const [caseResult] = result.results;

    expect(caseResult.error).toBeUndefined();
    expect(caseResult.output).toBe('ok');
    expect(caseResult.scores.map((s) => s.score)).toEqual([0.8]);
    expect(caseResult.trials?.map((t) => t.error)).toEqual(['first failed', undefined, undefined]);
    expect(result.aggregated.m.mean).toBe(0.8);
    expect(result.aggregated.m.count).toBe(1);
    expect(result.stats.errors).toBe(0);
  });

  it('counts a case as errored when every trial errored', async () => {
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
      target: {
        fn: async (input) => {
          if (input === 'a') throw new Error('always');
          return 'ok';
        },
      },
      trials: 2,
    });

    const { stats } = await suite.run();

    expect(stats.errors).toBe(1);
  });

  it('feeds every trial to latency and cost', async () => {
    const costs = [1, 9];
    const cogitator = fakeCogitator((_options, call) => ({ output: 'x', cost: costs[call] }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }]),
      target: { agent: {}, cogitator },
      statisticalMetrics: [cost(), latency()],
      trials: 2,
      concurrency: 1,
    });

    const { aggregated } = await suite.run();

    expect(aggregated.cost.mean).toBe(5);
    expect(aggregated.cost.metadata?.total).toBe(10);
    expect(aggregated.latency.metadata).toBeDefined();
    expect((aggregated.latency.metadata as { mean: number }).mean).toBeGreaterThanOrEqual(0);
  });

  it('shows the trials per case in the GitHub summary', async () => {
    const result = await new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }]),
      target: { fn: async () => 'ok' },
      trials: 3,
    }).run();

    expect(githubSummary(result)).toContain('**2** cases x **3** trials');
  });
});
