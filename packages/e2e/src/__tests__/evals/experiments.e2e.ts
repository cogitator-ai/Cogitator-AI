import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Cogitator, Agent } from '@cogitator-ai/core';
import {
  EvalSuite,
  Dataset,
  RunStore,
  compareRuns,
  contains,
  exactMatch,
  loadRun,
  reportComparison,
} from '@cogitator-ai/evals';
import type { EvalSuiteResult } from '@cogitator-ai/evals';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const MODEL = 'google/gemini-3.5-flash-lite';
const describeIf = GOOGLE_API_KEY ? describe : describe.skip;

const DATASET = Dataset.from([
  { input: 'What is the capital of France?', expected: 'Paris' },
  { input: 'What is the capital of Japan?', expected: 'Tokyo' },
  { input: 'What is the capital of Italy?', expected: 'Rome' },
]);

const TRACE_ID = /^[0-9a-f]{32}$/;

describeIf('Evals E2E: experiment tracking', () => {
  let cogitator: Cogitator;
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-experiments-'));

  beforeAll(() => {
    cogitator = new Cogitator({
      llm: { defaultModel: MODEL, providers: { google: { apiKey: GOOGLE_API_KEY! } } },
    });
  });

  afterAll(async () => {
    await cogitator.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves two agent runs with different instructions and compares them', async () => {
    const agent = new Agent({
      name: 'capitals-agent',
      model: MODEL,
      instructions: 'Answer geography questions.',
      temperature: 0,
    });
    const store = new RunStore(join(dir, 'runs'));

    const runVersion = async (variant: string): Promise<EvalSuiteResult> => {
      const suite = new EvalSuite({
        dataset: DATASET,
        target: { agent, cogitator },
        metrics: [exactMatch(), contains()],
        name: 'capitals',
        metadata: { variant },
        retries: 2,
        timeout: 60_000,
        concurrency: 3,
      });
      return suite.run();
    };

    await cogitator.prompts.deploy(
      agent,
      'Reply with only the name of the city, with no punctuation and no other words.'
    );
    const first = await runVersion('city only');
    const firstPath = store.save(first);

    await cogitator.prompts.deploy(
      agent,
      'Reply with one full sentence that names the city, such as "The capital of Spain is Madrid."'
    );
    const second = await runVersion('full sentence');
    store.save(second);

    for (const result of [first, second]) {
      expect(result.stats.errors).toBe(0);
      for (const caseResult of result.results) {
        expect(caseResult.traceId).toMatch(TRACE_ID);
        expect(caseResult.prompt?.key).toBe('capitals-agent');
      }
      expect(new Set(result.results.map((r) => r.traceId)).size).toBe(3);
    }
    expect(first.results[0].prompt?.version).toBe(1);
    expect(second.results[0].prompt?.version).toBe(2);

    const savedFirst = loadRun(firstPath);
    expect(savedFirst.runId).toBe(first.runId);
    expect(savedFirst.name).toBe('capitals');
    expect(savedFirst.metadata).toEqual({ variant: 'city only' });
    expect(savedFirst.config.target).toEqual({
      kind: 'agent',
      name: 'capitals-agent',
      model: MODEL,
    });
    expect(savedFirst.prompts).toEqual([
      expect.objectContaining({ key: 'capitals-agent', version: 1 }),
    ]);
    expect(savedFirst.results.every((r) => TRACE_ID.test(r.traceId ?? ''))).toBe(true);
    expect(readFileSync(firstPath, 'utf-8')).not.toContain(GOOGLE_API_KEY!);

    const listed = store.list({ name: 'capitals' });
    expect(listed.map((r) => r.id)).toEqual([second.runId, first.runId]);

    const comparison = compareRuns(store.load(first.runId), store.latest({ name: 'capitals' })!, {
      seed: 1,
    });

    expect(comparison.base.runId).toBe(first.runId);
    expect(comparison.head.runId).toBe(second.runId);
    expect(comparison.matched).toBe(3);
    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toEqual([]);
    expect(Object.keys(comparison.metrics).sort()).toEqual(['contains', 'exactMatch']);
    expect(comparison.metrics.contains.n).toBe(3);
    expect(comparison.metrics.contains.head).toBe(1);
    expect(comparison.metrics.exactMatch.base).toBeGreaterThan(comparison.metrics.exactMatch.head);
    expect(comparison.metrics.exactMatch.regressed.length).toBeGreaterThan(0);
    expect(comparison.warnings).toEqual([
      expect.stringMatching(
        /^Prompt 'capitals-agent' differs: the base run used v1 .* the head run v2/
      ),
    ]);

    const path = join(dir, 'reports', 'comparison');
    reportComparison(comparison, 'markdown', { path });
    const markdown = readFileSync(`${path}.md`, 'utf-8');
    expect(markdown).toContain('### Run comparison');
    expect(markdown).toContain('**3** cases matched');
    expect(markdown).toContain("Prompt 'capitals-agent' differs");
    expect(markdown).toContain('| exactMatch |');
    expect(markdown).toContain('**Regressions**');

    second.report('markdown', { path: join(dir, 'reports', 'second') });
    expect(readFileSync(join(dir, 'reports', 'second.md'), 'utf-8')).toContain(
      '### Eval results: capitals'
    );
  }, 240_000);
});
