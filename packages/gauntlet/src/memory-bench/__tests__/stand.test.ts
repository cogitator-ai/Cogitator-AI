import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { EmbeddingService } from '@cogitator-ai/types';
import { Budget, BudgetExceededError, callCost } from '../budget.js';
import { CachedEmbeddingService } from '../embeddings.js';
import { bootstrapInterval, markdownReport, summarize } from '../report.js';
import { evidenceRecall, mapConcurrent, questionInput } from '../runner.js';
import { stratifiedSample, seededRandom } from '../sample.js';
import { runConsistencySuite } from '../consistency.js';
import type { BenchConversation, BenchScore } from '../types.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-bench-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function conversation(id: string, categories: string[]): BenchConversation {
  return {
    id,
    dataset: 'longmemeval-s',
    turns: [],
    questions: categories.map((category, index) => ({
      id: `${id}:${index}`,
      category,
      question: 'q',
      answer: 'a',
      scoring: { kind: 'token-f1' },
    })),
  };
}

describe('stratifiedSample', () => {
  const data = [
    conversation('a', ['x', 'x', 'x', 'x', 'x', 'x']),
    conversation('b', ['y', 'y', 'z']),
  ];

  it('keeps every category, in proportion, the same on every run', () => {
    const first = stratifiedSample(data, 4, 1);
    const picked = first.flatMap((c) => c.questions.map((q) => q.category)).sort();
    expect(picked).toHaveLength(4);
    expect(new Set(picked)).toEqual(new Set(['x', 'y', 'z']));
    expect(stratifiedSample(data, 4, 1)).toEqual(first);
  });

  it('keeps everything without a size or with a larger one', () => {
    expect(stratifiedSample(data, undefined, 1)).toEqual(data);
    expect(stratifiedSample(data, 50, 1)).toEqual(data);
  });

  it('draws numbers in [0, 1)', () => {
    const random = seededRandom(3);
    for (let i = 0; i < 100; i++) expect(random()).toBeGreaterThanOrEqual(0);
  });
});

describe('Budget', () => {
  it('prices long prompts five times and batches at half', () => {
    expect(callCost(50_000, 0)).toBeCloseTo(0.005);
    expect(callCost(200_000, 0)).toBeCloseTo(0.1);
    expect(callCost(1_000_000, 1_000_000, true)).toBeCloseTo(1.5);
  });

  it('refuses work over the limit and keeps a ledger across runs', async () => {
    const path = join(tempDir(), 'ledger.json');
    const budget = new Budget(1, 'run-1', path);
    budget.charge('answers', 0.6);
    budget.charge('answers', 0.2);
    expect(() => budget.reserve(0.3)).toThrow(BudgetExceededError);
    await budget.save();
    const next = new Budget(1, 'run-2', path);
    expect(next.ledgerUsd).toBeCloseTo(0.8);
    expect(next.spentUsd).toBe(0);
    expect(budget.byStage()).toEqual({ answers: expect.closeTo(0.8) });
  });
});

describe('Budget reservations', () => {
  it('holds work in flight against the limit until it is released', () => {
    const budget = new Budget(1, 'run', join(tempDir(), 'ledger.json'));
    const first = budget.reserve(0.6);
    expect(() => budget.reserve(0.6)).toThrow(BudgetExceededError);
    first();
    first();
    expect(() => budget.reserve(0.6)()).not.toThrow();
  });

  it('starts a resumed run from what it already spent', async () => {
    const path = join(tempDir(), 'ledger.json');
    const before = new Budget(1, 'run', path);
    before.charge('answers', 0.7);
    await before.save();
    const resumed = new Budget(1, 'run', path);
    expect(resumed.spentUsd).toBeCloseTo(0.7);
    expect(() => resumed.reserve(0.5)).toThrow(BudgetExceededError);
  });
});

describe('CachedEmbeddingService', () => {
  it('pays for a text once, across instances', async () => {
    const inner: EmbeddingService = {
      model: 'm',
      dimensions: 2,
      embed: vi.fn(async () => [1, 0]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map((text) => [text.length, 0.5])),
    };
    const path = join(tempDir(), 'vectors.sqlite');
    const first = new CachedEmbeddingService(inner, path);
    expect(await first.embedBatch(['ab', 'abc', 'ab'])).toEqual([
      [2, 0.5],
      [3, 0.5],
      [2, 0.5],
    ]);
    expect(inner.embedBatch).toHaveBeenCalledWith(['ab', 'abc']);
    first.close();

    const second = new CachedEmbeddingService(inner, path);
    expect(await second.embed('abc')).toEqual([3, 0.5]);
    expect(inner.embedBatch).toHaveBeenCalledTimes(1);
    expect(second.embeddedTokens).toBe(0);
    second.close();
  });
});

describe('CachedEmbeddingService under concurrency', () => {
  it('sends a text once while concurrent calls wait for it', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const embedBatch = vi.fn(async (texts: string[]) => {
      await gate;
      return texts.map(() => [1, 2]);
    });
    const service = new CachedEmbeddingService(
      { model: 'm', dimensions: 2, embed: vi.fn(), embedBatch },
      join(tempDir(), 'vectors.sqlite')
    );
    const calls = Array.from({ length: 6 }, () => service.embedBatch(['same text']));
    finish();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 6 }, () => [[1, 2]]));
    expect(embedBatch).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('asks before each request to the provider, and fails the call when refused', async () => {
    const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => [1]));
    const seen: number[] = [];
    const service = new CachedEmbeddingService(
      { model: 'm', dimensions: 1, embed: vi.fn(), embedBatch },
      join(tempDir(), 'vectors.sqlite'),
      (tokens) => {
        seen.push(tokens);
        if (seen.length > 1) throw new Error('budget');
      }
    );
    await service.embedBatch(['first']);
    await expect(service.embedBatch(['second'])).rejects.toThrow('budget');
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(seen.every((tokens) => tokens > 0)).toBe(true);
    service.close();
  });
});

describe('runner helpers', () => {
  it('opens a question with its date', () => {
    expect(
      questionInput({
        id: 'q',
        category: 'c',
        question: 'When?',
        answer: 'a',
        askedOn: '2023/06/01',
        scoring: { kind: 'token-f1' },
      })
    ).toBe('Today is 2023/06/01.\n\nWhen?');
  });

  it('measures how much evidence reached the model', () => {
    expect(
      evidenceRecall(
        ['I bought 3 bikes.', 'I sold one.'],
        [
          { role: 'user', content: '[date]\nI bought 3 bikes.' },
          { role: 'assistant', content: 'ok' },
        ]
      )
    ).toBe(0.5);
  });

  it('stops starting work after a failure and throws the first error', async () => {
    const started: number[] = [];
    await expect(
      mapConcurrent([1, 2, 3, 4, 5], 1, async (item) => {
        started.push(item);
        if (item === 2) throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});

describe('report', () => {
  const score = (strategy: string, category: string, value: number): BenchScore => ({
    dataset: 'longmemeval-s',
    conversationId: 'c',
    questionId: `${strategy}${category}${value}`,
    category,
    strategy,
    output: 'x',
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 50,
    costUsd: 0.001,
    durationMs: 1000,
    contextMs: 100,
    contextMessages: 3,
    contextTokens: 90,
    evidenceRecall: 1,
    score: value,
    judgeCostUsd: 0.0001,
  });

  it('summarizes by strategy and category and renders Markdown', () => {
    const rows = summarize([
      score('recent', 'a', 1),
      score('recent', 'b', 0),
      score('relevant', 'a', 1),
    ]);
    const recent = rows.find((r) => r.strategy === 'recent' && r.category === 'all');
    expect(recent).toMatchObject({
      questions: 2,
      accuracy: 0.5,
      cacheHitRate: 0.5,
      evidenceRecall: 1,
    });
    expect(markdownReport(rows)).toContain('| longmemeval-s | recent | 2 | 50.0%');
  });

  it('bootstraps an interval around the mean', () => {
    const [low, high] = bootstrapInterval([0, 1, 1, 0, 1, 1, 1, 0]);
    expect(low).toBeLessThan(0.625);
    expect(high).toBeGreaterThan(0.625);
  });
});

describe('consistency suite', () => {
  it('passes on every strategy', { timeout: 30_000 }, async () => {
    const checks = await runConsistencySuite();
    expect(checks.length).toBe(12);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });
});
