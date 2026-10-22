import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalSuite } from '../eval-suite';
import { Dataset } from '../datasets';
import { exactMatch, contains } from '../metrics/deterministic';
import { latency } from '../metrics/statistical';
import { llmMetric } from '../metrics/llm-judge';
import { threshold } from '../assertions';
import { caseKey, loadRun } from '../runs';
import { fingerprint, canonicalJson, toJson } from '../runs/json';
import type { EvalPrompt } from '../metrics/types';

interface RunOptions {
  input: string;
  threadId?: string;
}

interface FakeRun {
  output: string;
  traceId?: string;
  prompt?: EvalPrompt;
  fail?: string;
}

function fakeCogitator(answer: (options: RunOptions, call: number) => FakeRun) {
  let call = 0;
  const run = vi.fn(async (_agent: unknown, options: RunOptions) => {
    const turn = answer(options, call++);
    if (turn.fail) throw new Error(turn.fail);
    return {
      output: turn.output,
      toolCalls: [],
      ...(turn.traceId !== undefined && { trace: { traceId: turn.traceId, spans: [] } }),
      ...(turn.prompt && { prompt: turn.prompt }),
    };
  });
  return { run, apiKey: 'sk-secret-value' };
}

const agent = { name: 'support', model: 'google/gemini-3.5-flash-lite', instructions: 'Be brief' };

const CASES = [
  { input: 'What is 2+2?', expected: '4' },
  { input: 'Capital of France?', expected: 'Paris' },
];

const ANSWERS: Record<string, string> = { 'What is 2+2?': '4', 'Capital of France?': 'Lyon' };

function fnSuite(options: { name?: string; metadata?: Record<string, unknown> } = {}) {
  return new EvalSuite({
    dataset: Dataset.from(CASES),
    target: { fn: async (input) => ANSWERS[input] ?? '' },
    metrics: [exactMatch(), contains()],
    statisticalMetrics: [latency()],
    assertions: [threshold('exactMatch', 0.9)],
    concurrency: 2,
    ...options,
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cogitator-run-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('agent run identity', () => {
  it('keeps the trace and the prompt of a single-turn agent case', async () => {
    const prompt = { key: 'support', versionId: 'ver_1', version: 1 };
    const cogitator = fakeCogitator((_o, call) => ({
      output: '4',
      traceId: `trace-${call}`,
      prompt,
    }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'What is 2+2?', expected: '4' }]),
      target: { agent, cogitator },
      metrics: [exactMatch()],
    });

    const result = await suite.run();

    expect(result.results[0].traceId).toBe('trace-0');
    expect(result.results[0].prompt).toEqual(prompt);
    expect(result.results[0].turns).toBeUndefined();
  });

  it('keeps each turn its own trace and prompt, the case the last turn', async () => {
    const cogitator = fakeCogitator((_o, call) => ({
      output: `answer ${call}`,
      traceId: `trace-${call}`,
      prompt: { key: 'support', versionId: `ver_${call}`, version: call },
    }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'hi', turns: ['and then?'] }]),
      target: { agent, cogitator },
    });

    const [caseResult] = (await suite.run()).results;

    expect(caseResult.turns?.map((t) => t.traceId)).toEqual(['trace-0', 'trace-1']);
    expect(caseResult.turns?.map((t) => t.prompt?.versionId)).toEqual(['ver_0', 'ver_1']);
    expect(caseResult.traceId).toBe('trace-1');
    expect(caseResult.prompt?.versionId).toBe('ver_1');
  });

  it('keeps the trace of every trial and of the answering attempt', async () => {
    const cogitator = fakeCogitator((_o, call) =>
      call === 0 ? { output: '', fail: 'flaky' } : { output: '4', traceId: `trace-${call}` }
    );
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'What is 2+2?', expected: '4' }]),
      target: { agent, cogitator },
      trials: 2,
      retries: 1,
      concurrency: 1,
    });

    const [caseResult] = (await suite.run()).results;

    expect(caseResult.trials?.map((t) => t.traceId)).toEqual(['trace-1', 'trace-2']);
    expect(caseResult.traceId).toBe('trace-1');
  });

  it('ignores a trace or prompt that does not have the expected shape', async () => {
    const run = vi.fn(async () => ({ output: 'x', trace: { traceId: 7 }, prompt: { version: 2 } }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'q' }]),
      target: { agent, cogitator: { run } },
    });

    const [caseResult] = (await suite.run()).results;

    expect(caseResult.traceId).toBeUndefined();
    expect(caseResult.prompt).toBeUndefined();
  });

  it('writes the trace and prompt into the JSON report', async () => {
    const cogitator = fakeCogitator(() => ({
      output: '4',
      traceId: 'trace-json',
      prompt: { key: 'support' },
    }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'What is 2+2?' }]),
      target: { agent, cogitator },
    });
    const result = await suite.run();

    result.report('json', { path: join(dir, 'report') });

    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf-8'));
    expect(json.results[0]).toMatchObject({ traceId: 'trace-json', prompt: { key: 'support' } });
  });
});

describe('experiment options', () => {
  it('puts the name and metadata on the result', async () => {
    const result = await fnSuite({
      name: 'qa',
      metadata: { branch: 'main', pr: 12, tags: ['nightly'], commit: undefined },
    }).run();

    expect(result.name).toBe('qa');
    expect(result.metadata).toEqual({ branch: 'main', pr: 12, tags: ['nightly'] });
  });

  it('refuses metadata JSON cannot hold and an empty name', () => {
    expect(() => fnSuite({ metadata: { at: () => 1 } })).toThrow(/EvalSuite: metadata\.at/);
    expect(() => fnSuite({ metadata: { ratio: Number.NaN } })).toThrow(/metadata\.ratio/);
    expect(() => fnSuite({ name: '  ' })).toThrow(/name must not be empty/);
  });

  it('gives every run its own id and its times', async () => {
    const suite = fnSuite();
    const first = await suite.run();
    const second = await suite.run();

    expect(first.runId).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
    expect(second.runId).not.toBe(first.runId);
    expect(Date.parse(first.finishedAt)).toBeGreaterThanOrEqual(Date.parse(first.startedAt));
  });
});

describe('run files', () => {
  it('records the run, its dataset, configuration and cases', async () => {
    const result = await fnSuite({ name: 'qa', metadata: { branch: 'main' } }).run();
    const run = result.toRun();

    expect(run).toMatchObject({
      format: 'cogitator.eval-run',
      version: 1,
      runId: result.runId,
      name: 'qa',
      metadata: { branch: 'main' },
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      dataset: { fingerprint: fingerprint(CASES), cases: 2 },
      config: {
        metrics: ['exactMatch', 'contains'],
        statisticalMetrics: ['latency'],
        trials: 1,
        concurrency: 2,
        target: { kind: 'fn' },
      },
      prompts: [],
      stats: { total: 2, errors: 0 },
    });
    expect(run.config.judge).toBeUndefined();
    expect(run.results.map((r) => r.caseKey)).toEqual(CASES.map((c) => caseKey(c)));
    expect(run.results[1]).toMatchObject({ output: 'Lyon', scores: [{ name: 'exactMatch' }, {}] });
    expect(run.aggregated.exactMatch.mean).toBe(0.5);
    expect(run.assertions[0]).toMatchObject({ name: 'threshold(exactMatch)', passed: false });
    expect(result.toRun()).toBe(run);
  });

  it('records the judge settings and the agent, never the Cogitator or its keys', async () => {
    const cogitator = fakeCogitator(() => ({ output: '4', traceId: 't' }));
    const judge = vi.fn(async () => ({ output: '{"score": 1, "reasoning": "ok"}' }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'What is 2+2?', expected: '4' }]),
      target: { agent, cogitator },
      metrics: [llmMetric({ name: 'judged', prompt: 'Is it right?' })],
      judge: { model: 'judge/model', temperature: 0.2, samples: 2, cogitator: { run: judge } },
    });

    const result = await suite.run();
    const run = result.toRun();
    const path = result.saveRun(join(dir, 'run.json'));
    const text = readFileSync(path, 'utf-8');

    expect(run.config.judge).toEqual({ model: 'judge/model', temperature: 0.2, samples: 2 });
    expect(run.config.target).toEqual({
      kind: 'agent',
      name: 'support',
      model: 'google/gemini-3.5-flash-lite',
    });
    expect(text).not.toContain('sk-secret-value');
    expect(text).not.toContain('Be brief');
  });

  it('lists the distinct prompts the agent runs used', async () => {
    const versions = [
      { key: 'support', versionId: 'ver_1', version: 1 },
      { key: 'support', versionId: 'ver_2', version: 2 },
    ];
    const cogitator = fakeCogitator((_o, call) => ({
      output: 'x',
      prompt: versions[call % 2],
    }));
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'a' }, { input: 'b' }, { input: 'c', turns: ['d'] }]),
      target: { agent, cogitator },
      concurrency: 1,
    });

    const run = (await suite.run()).toRun();

    expect(run.prompts).toEqual(versions);
  });

  it('writes <runId>.json into a directory and to a path otherwise', async () => {
    const result = await fnSuite().run();
    mkdirSync(join(dir, 'existing'));

    const intoExisting = result.saveRun(join(dir, 'existing'));
    const intoNew = result.saveRun(join(dir, 'new', 'runs') + '/');
    const asFile = result.saveRun(join(dir, 'deep', 'run.json'));

    expect(intoExisting).toBe(join(dir, 'existing', `${result.runId}.json`));
    expect(intoNew).toBe(join(dir, 'new', 'runs', `${result.runId}.json`));
    expect(asFile).toBe(join(dir, 'deep', 'run.json'));
    expect(loadRun(asFile)).toEqual(result.toRun());
  });

  it('reads back a run whose metrics no case was scored on', async () => {
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'q', expected: 'a' }]),
      target: {
        fn: async () => {
          throw new Error('down');
        },
      },
      metrics: [exactMatch()],
    });
    const result = await suite.run();

    const run = loadRun(result.saveRun(join(dir, 'errored.json')));

    expect(run.aggregated.exactMatch.mean).toBeNaN();
    expect(run.results[0].error).toBe('down');
    expect(run.stats.errors).toBe(1);
  });

  it('keeps every trial with its own scores', async () => {
    let call = 0;
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'q', expected: 'a' }]),
      target: { fn: async () => (call++ === 0 ? 'a' : 'b') },
      metrics: [exactMatch()],
      trials: 2,
      concurrency: 1,
    });

    const run = loadRun((await suite.run()).saveRun(join(dir, 'trials.json')));

    expect(run.config.trials).toBe(2);
    expect(run.results[0].trials?.map((t) => t.scores[0].score)).toEqual([1, 0]);
  });

  it('turns values JSON cannot hold into what JSON keeps', async () => {
    const circular: Record<string, unknown> = { id: 1 };
    circular.self = circular;
    const suite = new EvalSuite({
      dataset: Dataset.from([{ input: 'q', context: { big: 10n, fn: () => 1, circular } }]),
      target: { fn: async () => 'a' },
    });

    const run = (await suite.run()).toRun();

    expect(run.results[0].case.context).toEqual({
      big: '10',
      circular: { id: 1, self: '[Circular]' },
    });
  });

  it('rejects a file that is not a valid run file of this version', () => {
    const write = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };

    expect(() => loadRun(join(dir, 'missing.json'))).toThrow(/Cannot read the run file/);
    expect(() => loadRun(write('a.json', '{oops'))).toThrow(/is not JSON/);
    expect(() => loadRun(write('b.json', '{"exactMatch": 1}'))).toThrow(/is not an eval run file/);
    expect(() =>
      loadRun(write('c.json', '{"format": "cogitator.eval-run", "version": 2}'))
    ).toThrow(/version 2, this version of @cogitator-ai\/evals reads version 1/);
    expect(() =>
      loadRun(write('d.json', '{"format": "cogitator.eval-run", "version": 1, "runId": "x"}'))
    ).toThrow(/is not a valid eval run file: .*startedAt/);
  });
});

describe('case keys and fingerprints', () => {
  it('keys a case by its input, turns and expected answer only', () => {
    const key = caseKey({ input: 'q', expected: 'a' });

    expect(caseKey({ expected: 'a', input: 'q' })).toBe(key);
    expect(caseKey({ input: 'q', expected: 'b' })).not.toBe(key);
    expect(caseKey({ input: 'q', expected: 'a', turns: ['more'] })).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes the same canonical JSON for the same data in any key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,null]},"b":1}'
    );
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(toJson({ when: new Date(0), skip: undefined, n: Infinity })).toEqual({
      when: '1970-01-01T00:00:00.000Z',
      n: null,
    });
  });

  it('fingerprints the cases run, so maxCases changes it', async () => {
    const suite = fnSuite();
    const all = (await suite.run()).toRun();
    const first = (await suite.run({ maxCases: 1 })).toRun();

    expect(all.dataset.fingerprint).toBe(fingerprint(suite.cases()));
    expect(first.dataset).toEqual({ fingerprint: fingerprint(suite.cases(1)), cases: 1 });
    expect(first.dataset.fingerprint).not.toBe(all.dataset.fingerprint);
  });
});
