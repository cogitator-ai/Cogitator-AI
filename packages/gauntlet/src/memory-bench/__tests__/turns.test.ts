import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicBackend } from '@cogitator-ai/core';
import type { ChatRequest, ChatResponse } from '@cogitator-ai/types';
import { Budget } from '../budget.js';
import { latest, splitTurns } from '../options.js';
import {
  cacheFigures,
  cachePriceNote,
  inputCostRatio,
  markdownReport,
  summarize,
} from '../report.js';
import {
  answerConversation,
  answerKey,
  followUps,
  NEUTRAL_FOLLOW_UP,
  type AnswerOptions,
} from '../runner.js';
import type { BenchAnswer, BenchConversation, BenchScore } from '../types.js';

const dirs: string[] = [];
const budgets: Budget[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(budgets.splice(0).map((budget) => budget.save()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function budget(limitUsd = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-bench-turns-'));
  dirs.push(dir);
  const created = new Budget(limitUsd, 'test', join(dir, 'ledger.json'));
  budgets.push(created);
  return created;
}

const conversation: BenchConversation = {
  id: 'c1',
  dataset: 'beam-100k',
  turns: [
    { role: 'user', content: 'My cat is called Miso.' },
    { role: 'assistant', content: 'Lovely name.' },
    { role: 'user', content: 'I moved to Porto last spring.' },
    { role: 'assistant', content: 'Porto is beautiful.' },
  ],
  questions: ['What is my cat called?', 'Where did I move?', 'When did I move?'].map(
    (question, index) => ({
      id: `q${index + 1}`,
      category: 'recall',
      question,
      answer: 'x',
      scoring: { kind: 'token-f1' as const },
    })
  ),
};

const textOf = (request: ChatRequest) =>
  request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

function stubModel() {
  const requests: ChatRequest[] = [];
  vi.spyOn(AnthropicBackend.prototype, 'chat').mockImplementation(async (request) => {
    requests.push({ ...request, messages: [...request.messages] });
    const followUp = request.messages.filter((m) => m.role === 'user').length > 3;
    const response: ChatResponse = {
      id: 'stub',
      content: `answer ${requests.length}`,
      finishReason: 'stop',
      usage: followUp
        ? {
            inputTokens: 1000,
            outputTokens: 20,
            totalTokens: 1020,
            cachedInputTokens: 900,
            cacheWriteTokens: 50,
          }
        : { inputTokens: 1000, outputTokens: 20, totalTokens: 1020, cacheWriteTokens: 1000 },
    };
    return response;
  });
  return requests;
}

function options(overrides: Partial<AnswerOptions> = {}) {
  const answers: BenchAnswer[] = [];
  const base: AnswerOptions = {
    strategy: { name: 'recent', contextTokens: 4000 },
    anthropicApiKey: 'test-key',
    budget: budget(),
    concurrency: 3,
    done: new Set(),
    onAnswer: async (answer) => {
      answers.push(answer);
    },
    log: () => undefined,
    ...overrides,
  };
  return { options: base, answers };
}

describe('followUps', () => {
  it('asks the next questions of the conversation, wrapping around', () => {
    expect(followUps(conversation, conversation.questions[1], 3)).toEqual([
      'When did I move?',
      'What is my cat called?',
    ]);
  });

  it('falls back to the neutral follow-up once the questions run out', () => {
    const single = { ...conversation, questions: [conversation.questions[0]] };
    expect(followUps(single, single.questions[0], 3)).toEqual([
      NEUTRAL_FOLLOW_UP,
      NEUTRAL_FOLLOW_UP,
    ]);
    expect(followUps(conversation, conversation.questions[0], 4)).toEqual([
      'Where did I move?',
      'When did I move?',
      NEUTRAL_FOLLOW_UP,
    ]);
  });

  it('asks nothing more on a single turn', () => {
    expect(followUps(conversation, conversation.questions[0], 1)).toEqual([]);
  });
});

describe('answerKey', () => {
  it('keeps the key of first turns and tells later turns apart', () => {
    expect(answerKey('d', 'q', 's')).toBe(answerKey('d', 'q', 's', 1));
    expect(answerKey('d', 'q', 's', 2)).not.toBe(answerKey('d', 'q', 's'));
    expect(answerKey('d', 'q', 's', 2)).not.toBe(answerKey('d', 'q', 's', 3));
  });
});

describe('answerConversation with turns', () => {
  it('chains each question on a branch of its own, every turn seeing the ones before it', async () => {
    const requests = stubModel();
    const { options: opts, answers } = options({ turns: 3 });
    await answerConversation(conversation, opts);

    expect(answers).toHaveLength(9);
    expect(answers.every((answer) => answer.error === undefined)).toBe(true);
    for (const question of conversation.questions) {
      const turns = answers
        .filter((answer) => answer.questionId === question.id)
        .map((answer) => answer.turn ?? 1)
        .sort();
      expect(turns).toEqual([1, 2, 3]);
    }

    const chains = conversation.questions.map((question) => [
      question.question,
      ...followUps(conversation, question, 3),
    ]);
    const depths: number[] = [];
    for (const request of requests) {
      expect(textOf(request)).toContain('My cat is called Miso.');
      const asked = request.messages
        .filter((m) => m.role === 'user')
        .slice(2)
        .map((m) => (typeof m.content === 'string' ? m.content : ''));
      const chain = chains.find((inputs) => asked[0]?.includes(inputs[0]));
      expect(chain).toBeDefined();
      asked.forEach((text, i) => expect(text).toContain(chain?.[i]));
      depths.push(asked.length);
      if (asked.length > 1) {
        expect(request.messages.filter((m) => m.role === 'assistant').length).toBe(
          asked.length + 1
        );
      }
    }
    expect(depths.sort()).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);

    const second = answers.find((answer) => answer.turn === 2);
    expect(second).toMatchObject({ cachedInputTokens: 900, cacheWriteTokens: 50 });
    const first = answers.find((answer) => answer.turn === undefined);
    expect(first).toMatchObject({ cachedInputTokens: 0, cacheWriteTokens: 1000 });
    expect(first?.cacheWrite1hTokens).toBeUndefined();
  });

  it('asks a chain again whole when a turn is missing and skips finished ones', async () => {
    const requests = stubModel();
    const key = (id: string, turn: number) => answerKey('beam-100k', id, 'recent', turn);
    const { options: opts, answers } = options({
      turns: 2,
      done: new Set([key('q1', 1), key('q2', 1), key('q2', 2), key('q3', 1), key('q3', 2)]),
    });
    await answerConversation(conversation, opts);
    expect(requests).toHaveLength(2);
    expect(answers.map((answer) => [answer.questionId, answer.turn ?? 1])).toEqual([
      ['q1', 1],
      ['q1', 2],
    ]);
  });

  it('keeps a single turn unsaved, as before turns', async () => {
    const requests = stubModel();
    const { options: opts, answers } = options();
    await answerConversation(conversation, opts);
    expect(answers).toHaveLength(3);
    expect(answers.every((answer) => answer.turn === undefined)).toBe(true);
    for (const request of requests) {
      expect(request.messages.filter((m) => m.role === 'user')).toHaveLength(3);
    }
  });

  it('ends a chain at a failed turn', async () => {
    const requests: ChatRequest[] = [];
    vi.spyOn(AnthropicBackend.prototype, 'chat').mockImplementation(async (request) => {
      requests.push(request);
      throw new Error('overloaded');
    });
    const { options: opts, answers } = options({ turns: 3, concurrency: 1 });
    await answerConversation({ ...conversation, questions: [conversation.questions[0]] }, opts);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ questionId: 'q1', cacheWriteTokens: 0 });
    expect(answers[0]?.error).toContain('overloaded');
  });
});

const answer = (overrides: Partial<BenchAnswer> = {}): BenchAnswer => ({
  dataset: 'beam-100k',
  conversationId: 'c',
  questionId: 'q',
  category: 'a',
  strategy: 'recent',
  output: 'x',
  inputTokens: 1000,
  outputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
  durationMs: 1000,
  contextMs: 100,
  contextMessages: 3,
  contextTokens: 900,
  ...overrides,
});

const scored = (overrides: Partial<BenchAnswer> = {}): BenchScore => ({
  ...answer(overrides),
  score: 1,
  judgeCostUsd: 0,
});

describe('inputCostRatio', () => {
  it('is 1 without the cache and without input', () => {
    expect(inputCostRatio({ input: 1000, cached: 0, written: 0, written1h: 0 })).toBe(1);
    expect(inputCostRatio({ input: 0, cached: 0, written: 0, written1h: 0 })).toBe(1);
  });

  it('prices reads at 0.1x, 5-minute writes at 1.25x and 1-hour writes at 2x', () => {
    expect(inputCostRatio({ input: 1000, cached: 1000, written: 0, written1h: 0 })).toBeCloseTo(
      0.1
    );
    expect(inputCostRatio({ input: 1000, cached: 0, written: 1000, written1h: 0 })).toBeCloseTo(
      1.25
    );
    expect(inputCostRatio({ input: 1000, cached: 0, written: 1000, written1h: 1000 })).toBeCloseTo(
      2
    );
    expect(inputCostRatio({ input: 1000, cached: 800, written: 100, written1h: 0 })).toBeCloseTo(
      (100 + 800 * 0.1 + 100 * 1.25) / 1000
    );
  });

  it('never counts more cached or written tokens than the input holds', () => {
    expect(inputCostRatio({ input: 100, cached: 500, written: 500, written1h: 500 })).toBeCloseTo(
      0.1
    );
    expect(inputCostRatio({ input: 100, cached: 0, written: 100, written1h: 500 })).toBeCloseTo(2);
  });

  it('takes the write price for 1-hour writes when the model has no price of its own', () => {
    expect(
      inputCostRatio(
        { input: 100, cached: 0, written: 100, written1h: 100 },
        { input: 1, output: 5, inputCacheWrite: 1.25 }
      )
    ).toBeCloseTo(1.25);
  });

  it('says how the bench prices the cache', () => {
    expect(cachePriceNote()).toContain('reads at 0.10x, 5-minute cache writes at 1.25x');
    expect(cachePriceNote()).toContain('1-hour ones at 2.00x');
  });
});

describe('cacheFigures', () => {
  it('counts writes per query and the cost ratio of the whole group', () => {
    const figures = cacheFigures([
      answer({ cacheWriteTokens: 1000 }),
      answer({ cachedInputTokens: 900, cacheWriteTokens: 100 }),
    ]);
    expect(figures.inputTokensPerQuery).toBe(1000);
    expect(figures.cacheHitRate).toBeCloseTo(0.45);
    expect(figures.cacheWriteTokensPerQuery).toBe(550);
    expect(figures.effectiveInputCostRatio).toBeCloseTo((900 * 0.1 + 1100 * 1.25) / 2000);
  });

  it('leaves writes out for answers recorded before them', () => {
    const { cacheWriteTokens: _written, ...old } = answer({ cachedInputTokens: 500 });
    const figures = cacheFigures([old, answer()]);
    expect(figures.cacheHitRate).toBeCloseTo(0.25);
    expect(figures.cacheWriteTokensPerQuery).toBeUndefined();
    expect(figures.effectiveInputCostRatio).toBeUndefined();
  });
});

describe('report of turns', () => {
  it('reports follow-up turns apart from the first ones', () => {
    const rows = summarize(
      [scored({ cacheWriteTokens: 1000 })],
      [],
      [
        answer({ turn: 2, cachedInputTokens: 900, cacheWriteTokens: 100, costUsd: 0.0004 }),
        answer({ turn: 3, cachedInputTokens: 950, cacheWriteTokens: 50, costUsd: 0.0003 }),
        answer({ turn: 2, questionId: 'q2', error: 'overloaded', inputTokens: 0 }),
      ]
    );
    const overall = rows.find((r) => r.category === undefined);
    expect(overall).toMatchObject({
      questions: 1,
      cacheHitRate: 0,
      cacheWriteTokensPerQuery: 1000,
    });
    expect(overall?.effectiveInputCostRatio).toBeCloseTo(1.25);
    expect(overall?.followUps).toMatchObject({ turns: 2, errors: 1, cacheWriteTokensPerQuery: 75 });
    expect(overall?.followUps?.cacheHitRate).toBeCloseTo(0.925);
    expect(overall?.costUsd).toBeCloseTo(0.001 + 0.0004 + 0.0003 + 0.001);

    const markdown = markdownReport(rows);
    expect(markdown).toContain('### Follow-up turns');
    expect(markdown).toContain(
      '| beam-100k | recent | 2 (1 failed) | 1000 / 1000 | 0.0% / 92.5% |'
    );
    expect(markdown).toContain('| 1000 | 1.25x |');
  });

  it('reads runs recorded before cache writes and turns', () => {
    const { cacheWriteTokens: _written, ...old } = scored({ cachedInputTokens: 500 });
    const rows = summarize([old]);
    const overall = rows.find((r) => r.category === undefined);
    expect(overall?.followUps).toBeUndefined();
    expect(overall?.cacheWriteTokensPerQuery).toBeUndefined();
    const markdown = markdownReport(rows);
    expect(markdown).toContain('| 50.0% | n/a | n/a |');
    expect(markdown).not.toContain('### Follow-up turns');
  });

  it('splits answers into first turns and follow-ups up to the turns asked', () => {
    const records = [
      answer(),
      answer({ turn: 2 }),
      answer({ turn: 3 }),
      answer({ turn: 2, output: 'newer' }),
    ];
    const kept = latest(records);
    expect(kept.size).toBe(3);
    const { first, followUps: later } = splitTurns(kept.values(), 2);
    expect(first).toHaveLength(1);
    expect(later.map((a) => [a.turn, a.output])).toEqual([[2, 'newer']]);
    expect(splitTurns(kept.values(), 1).followUps).toEqual([]);
  });
});
