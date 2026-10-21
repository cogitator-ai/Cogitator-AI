import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicBackend } from '@cogitator-ai/core';
import type { ChatRequest, ChatResponse, EmbeddingService } from '@cogitator-ai/types';
import { countTokens } from '@cogitator-ai/memory';
import { Budget, BudgetExceededError, callCost, usageCost } from '../budget.js';
import { HashedWordsEmbedding } from '../consistency.js';
import {
  answerConversation,
  answerKey,
  CLOSING_TURN,
  compactionEstimate,
  type AnswerOptions,
} from '../runner.js';
import type { BenchAnswer, BenchConversation } from '../types.js';

const dirs: string[] = [];
const budgets: Budget[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(budgets.splice(0).map((budget) => budget.save()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function budget(limitUsd = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-bench-runner-'));
  dirs.push(dir);
  const created = new Budget(limitUsd, 'test', join(dir, 'ledger.json'));
  budgets.push(created);
  return created;
}

const conversation: BenchConversation = {
  id: 'c1',
  dataset: 'longmemeval-s',
  turns: [
    { role: 'user', content: 'My cat is called Miso.', evidence: true },
    { role: 'assistant', content: 'Lovely name.' },
    { role: 'user', content: 'I moved to Porto last spring.' },
    { role: 'assistant', content: 'Porto is beautiful.' },
  ],
  questions: [
    {
      id: 'q1',
      category: 'single-session-user',
      question: 'What is my cat called?',
      answer: 'Miso',
      evidence: ['My cat is called Miso.'],
      scoring: { kind: 'token-f1' },
    },
    {
      id: 'q2',
      category: 'single-session-user',
      question: 'Where did I move?',
      answer: 'Porto',
      scoring: { kind: 'token-f1' },
    },
  ],
};

function stubModel(reply: (request: ChatRequest) => string | Error) {
  const requests: ChatRequest[] = [];
  vi.spyOn(AnthropicBackend.prototype, 'chat').mockImplementation(async (request) => {
    requests.push(request);
    const text = reply(request);
    if (text instanceof Error) throw text;
    const response: ChatResponse = {
      id: 'stub',
      content: text,
      finishReason: 'stop',
      usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 },
    };
    return response;
  });
  return requests;
}

function options(overrides: Partial<AnswerOptions> = {}) {
  const answers: BenchAnswer[] = [];
  const lines: string[] = [];
  const base: AnswerOptions = {
    strategy: { name: 'recent', contextTokens: 2000 },
    anthropicApiKey: 'test-key',
    budget: budget(),
    concurrency: 2,
    done: new Set(),
    onAnswer: async (answer) => {
      answers.push(answer);
    },
    log: (line) => lines.push(line),
    ...overrides,
  };
  return { options: base, answers, lines };
}

const textOf = (request: ChatRequest) =>
  request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');

describe('answerConversation', () => {
  it('answers each question from memory alone, the evidence measured and the cost charged', async () => {
    const requests = stubModel((request) =>
      textOf(request).includes('What is my cat called?') ? 'Miso' : 'Porto'
    );
    const { options: opts, answers } = options();
    await answerConversation(conversation, opts);

    expect(answers.map((a) => [a.questionId, a.output, a.error])).toEqual(
      expect.arrayContaining([
        ['q1', 'Miso', undefined],
        ['q2', 'Porto', undefined],
      ])
    );
    const q1 = answers.find((a) => a.questionId === 'q1');
    expect(q1?.evidenceRecall).toBe(1);
    expect(q1?.contextMessages).toBeGreaterThan(0);
    expect(q1?.inputTokens).toBe(1000);
    expect(opts.budget.spentUsd).toBeGreaterThan(0);
    for (const request of requests) {
      const text = textOf(request);
      expect(text).toContain('My cat is called Miso.');
      expect(text.includes('What is my cat called?') && text.includes('Where did I move?')).toBe(
        false
      );
    }
  });

  it('skips questions already answered', async () => {
    const requests = stubModel(() => 'Porto');
    const { options: opts, answers } = options({
      done: new Set([answerKey('longmemeval-s', 'q1', 'recent')]),
    });
    await answerConversation(conversation, opts);
    expect(answers.map((a) => a.questionId)).toEqual(['q2']);
    expect(requests).toHaveLength(1);
  });

  it('records a failed call as an errored answer and goes on', async () => {
    stubModel((request) =>
      textOf(request).includes('What is my cat called?') ? new Error('overloaded') : 'Porto'
    );
    const { options: opts, answers, lines } = options();
    await answerConversation(conversation, opts);
    expect(answers.find((a) => a.questionId === 'q1')?.error).toContain('overloaded');
    expect(answers.find((a) => a.questionId === 'q2')?.output).toBe('Porto');
    expect(lines.some((line) => line.includes('q1'))).toBe(true);
  });

  it('marks an answer failed when the embeddings fail and the strategy falls back', async () => {
    stubModel(() => 'Miso');
    const broken: EmbeddingService = {
      model: 'broken',
      dimensions: 4,
      embed: async () => {
        throw new Error('quota');
      },
      embedBatch: async () => {
        throw new Error('quota');
      },
    };
    const { options: opts, answers } = options({
      strategy: { name: 'relevant', contextTokens: 2000 },
      embedding: broken,
    });
    await answerConversation(conversation, opts);
    expect(answers).toHaveLength(2);
    for (const answer of answers) expect(answer.error).toMatch(/^memory: .*fell back/);
  });

  it('stops when the embedding budget refuses while the context is built', async () => {
    const requests = stubModel(() => 'Miso');
    const spent = budget(0);
    const inner = new HashedWordsEmbedding();
    const refusing: EmbeddingService = {
      model: inner.model,
      dimensions: inner.dimensions,
      embed: async () => {
        throw spent.refusal();
      },
      embedBatch: (texts) => inner.embedBatch(texts),
    };
    const { options: opts, answers } = options({
      strategy: { name: 'relevant', contextTokens: 2000 },
      embedding: refusing,
    });
    await expect(answerConversation(conversation, opts)).rejects.toBeInstanceOf(
      BudgetExceededError
    );
    expect(answers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('warms the index with every entry once, whatever the dataset order, before the questions', async () => {
    const requests = stubModel(() => 'Miso');
    const late = Date.UTC(2025, 0, 1);
    const early = Date.UTC(2024, 0, 1);
    const first = Date.UTC(2023, 0, 1);
    const turns = Array.from({ length: 230 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i} talks about topic ${i} at some length.`,
      at: new Date(i === 0 ? first : i < 20 ? late + i * 60_000 : early + i * 60_000),
    }));
    const inner = new HashedWordsEmbedding();
    const batches: string[][] = [];
    const recording: EmbeddingService = {
      model: inner.model,
      dimensions: inner.dimensions,
      embed: (text) => inner.embed(text),
      embedBatch: async (texts) => {
        batches.push(texts);
        return inner.embedBatch(texts);
      },
    };
    const { options: opts } = options({
      strategy: { name: 'relevant', contextTokens: 2000 },
      embedding: recording,
    });
    await answerConversation(
      { ...conversation, turns, questions: [conversation.questions[0]] },
      opts
    );
    expect(requests).toHaveLength(1);
    expect(batches.at(-1)).toEqual([conversation.questions[0].question]);
    const embedded = batches.slice(0, -1).flat();
    expect(new Set(embedded).size).toBe(embedded.length);
    for (const turn of turns) expect(embedded).toContain(turn.content);
  });

  it('measures a strategy that works without an error', async () => {
    stubModel(() => 'Miso');
    const { options: opts, answers } = options({
      strategy: { name: 'hybrid', contextTokens: 2000 },
      embedding: new HashedWordsEmbedding(),
    });
    await answerConversation(conversation, opts);
    expect(answers.every((answer) => answer.error === undefined)).toBe(true);
  });

  it('stops on a spent budget instead of recording failures', async () => {
    stubModel(() => 'Miso');
    const { options: opts, answers } = options({ budget: budget(0.000001) });
    await expect(answerConversation(conversation, opts)).rejects.toBeInstanceOf(
      BudgetExceededError
    );
    expect(answers).toEqual([]);
  });
});

describe('answerConversation with the compacted strategy', () => {
  const isChapter = (request: ChatRequest) =>
    String(request.messages[0]?.content ?? '').startsWith('You compact');

  /** A chapter answer naming the cat line of the window, when it holds one, with its exact quote */
  const chapter = (request: ChatRequest) => {
    const line = textOf(request)
      .split('\n')
      .find((text) => text.includes('My cat is called Miso.'));
    const at = line && /^\[(\d+)\]/.exec(line)?.[1];
    return at === undefined || at === ''
      ? '[]'
      : JSON.stringify([
          {
            kind: 'fact',
            text: 'The user has a cat called Miso',
            evidence: [{ message: Number(at), quote: 'My cat is called Miso.' }],
          },
        ]);
  };

  const long: BenchConversation = {
    ...conversation,
    turns: [
      ...conversation.turns,
      ...Array.from({ length: 80 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `Filler ${i} about the garden, the weather and a long walk by the river.`,
      })),
    ],
  };
  const compacted = { strategy: { name: 'compacted' as const, contextTokens: 400 } };

  it('closes the session, lets the runtime compact the thread and answers from the summary', async () => {
    const requests = stubModel((request) => (isChapter(request) ? chapter(request) : 'Miso'));
    const { options: opts, answers } = options(compacted);
    await answerConversation(long, opts);

    expect(answers.map((answer) => [answer.questionId, answer.error])).toEqual(
      expect.arrayContaining([
        ['q1', undefined],
        ['q2', undefined],
      ])
    );
    expect(requests.some(isChapter)).toBe(true);
    const question = requests.find((request) => textOf(request).includes('What is my cat called?'));
    const seen = textOf(question!);
    expect(seen).toContain('[Conversation summary]');
    expect(seen).toContain('The user has a cat called Miso');
    expect(seen).toContain('That is all for now, thank you.');
    expect(seen).not.toContain('Filler 0 ');
    expect(opts.budget.byStage().compaction).toBeGreaterThan(0);
    expect(opts.budget.byStage().answers).toBeGreaterThan(0);
  });

  it('fails the questions when the runtime could not compact, asking nothing', async () => {
    const requests = stubModel((request) => (isChapter(request) ? 'no atoms today' : 'Miso'));
    const { options: opts, answers } = options(compacted);
    await answerConversation(long, opts);

    expect(answers).toHaveLength(2);
    for (const answer of answers) expect(answer.error).toMatch(/^compaction: /);
    expect(requests.filter(isChapter)).toHaveLength(3);
    expect(requests.some((request) => textOf(request).includes('What is my cat called?'))).toBe(
      false
    );
  });

  it('answers a conversation under the threshold as it is', async () => {
    const requests = stubModel(() => 'Miso');
    const { options: opts, answers, lines } = options(compacted);
    await answerConversation(conversation, opts);

    expect(answers.every((answer) => answer.error === undefined)).toBe(true);
    expect(requests.some(isChapter)).toBe(false);
    expect(lines.some((line) => line.includes('under the compaction threshold'))).toBe(true);
  });

  it('stops when the budget refuses a chapter call, though the runtime only logs it', async () => {
    vi.spyOn(AnthropicBackend.prototype, 'chat').mockImplementation(async (request) => ({
      id: 'stub',
      content: isChapter(request) ? chapter(request) : 'Miso',
      finishReason: 'stop',
      usage: { inputTokens: 20_000, outputTokens: 20, totalTokens: 20_020 },
    }));
    const { options: opts, answers } = options({ ...compacted, budget: budget(0.003) });
    await expect(answerConversation(long, opts)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(answers).toEqual([]);
  });
});

describe('compaction pricing', () => {
  it('prices the closing turn alone under the threshold, chapters above it', () => {
    const small = compactionEstimate(conversation, 8192);
    expect(small).toBeCloseTo(callCost(8192 + countTokens(CLOSING_TURN), 200));
    const turns = Array.from({ length: 2000 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Turn ${i} talks about topic ${i} at some length, with a few more words.`,
    }));
    const large = compactionEstimate({ ...conversation, turns }, 8192);
    const larger = compactionEstimate({ ...conversation, turns: [...turns, ...turns] }, 8192);
    expect(large).toBeGreaterThan(small);
    expect(larger).toBeGreaterThan(large * 1.8);
  });

  it('prices a reported usage per token class', () => {
    expect(usageCost({ inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 })).toBeCloseTo(
      0.01,
      9
    );
    const cached = usageCost({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 500_000,
      cacheWrite1hTokens: 100_000,
    });
    expect(cached).toBeCloseTo((0.005 + 0.05 + 0.02 + 0.5) * 5, 6);
  });
});
