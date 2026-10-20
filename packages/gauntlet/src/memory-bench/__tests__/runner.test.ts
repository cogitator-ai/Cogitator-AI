import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicBackend } from '@cogitator-ai/core';
import type { ChatRequest, ChatResponse, EmbeddingService } from '@cogitator-ai/types';
import { Budget, BudgetExceededError } from '../budget.js';
import { HashedWordsEmbedding } from '../consistency.js';
import { answerConversation, answerKey, type AnswerOptions } from '../runner.js';
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
