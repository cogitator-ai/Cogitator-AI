import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Budget, callCost } from '../budget.js';
import { judge, JudgeStore } from '../judge.js';
import { latest, parseSample, pick, positive, readJsonl, UsageError } from '../options.js';
import type { JudgeRequest } from '../scoring.js';
import type { BenchAnswer } from '../types.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-bench-judge-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const usage = { input_tokens: 1000, output_tokens: 10 };

const message = (text: string) => ({
  content: [{ type: 'text', text }],
  usage,
});

interface BatchResult {
  custom_id: string;
  result: { type: 'succeeded'; message: ReturnType<typeof message> } | { type: 'errored' };
}

/** The part of the Anthropic client the judge uses, answering from `answer` and recording calls. */
function fakeClient(options: {
  answer(prompt: string): string;
  failDirect?: (prompt: string) => boolean;
  batchResults?: (requests: { custom_id: string; prompt: string }[]) => BatchResult[];
}) {
  const calls = { direct: [] as string[], batches: [] as string[][], retrieved: [] as string[] };
  const batches = new Map<string, BatchResult[]>();
  const client = {
    messages: {
      async create(params: { messages: { content: string }[] }) {
        const prompt = params.messages[0].content;
        calls.direct.push(prompt);
        if (options.failDirect?.(prompt)) throw new Error('connection reset');
        return message(options.answer(prompt));
      },
      batches: {
        async create(params: {
          requests: { custom_id: string; params: { messages: { content: string }[] } }[];
        }) {
          const id = `batch-${batches.size + 1}`;
          const requests = params.requests.map((request) => ({
            custom_id: request.custom_id,
            prompt: request.params.messages[0].content,
          }));
          calls.batches.push(requests.map((request) => request.prompt));
          batches.set(
            id,
            options.batchResults?.(requests) ??
              requests.map((request) => ({
                custom_id: request.custom_id,
                result: { type: 'succeeded', message: message(options.answer(request.prompt)) },
              }))
          );
          return { id };
        },
        async retrieve(id: string) {
          calls.retrieved.push(id);
          return { id, processing_status: 'ended' };
        },
        async results(id: string) {
          const results = batches.get(id) ?? [];
          return (async function* () {
            yield* results;
          })();
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls, batches };
}

const request = (id: string, prompt = id): JudgeRequest => ({
  id,
  prompt,
  maxTokens: 16,
  read: (text) => (text === 'yes' ? 1 : 0),
});

function setup() {
  const dir = tempDir();
  const store = new JudgeStore(join(dir, 'replies.jsonl'), join(dir, 'batches.json'));
  const budget = new Budget(1, 'test', join(dir, 'ledger.json'));
  const lines: string[] = [];
  return { dir, store, budget, lines, log: (line: string) => lines.push(line) };
}

describe('judge', () => {
  it('judges in a batch at half price and closes the batch', async () => {
    const { store, budget, log } = setup();
    const { client, calls } = fakeClient({ answer: () => 'yes' });
    await judge([request('a'), request('b')], {
      client,
      batch: true,
      budget,
      store,
      concurrency: 2,
      log,
      pollMs: 0,
    });
    expect(calls.batches).toEqual([['a', 'b']]);
    expect(calls.direct).toEqual([]);
    expect(store.replies.get('a')).toEqual({ text: 'yes', costUsd: callCost(1000, 10, true) });
    expect(budget.spentUsd).toBeCloseTo(2 * callCost(1000, 10, true));
    expect(store.openBatches).toEqual([]);
  });

  it('asks one by one what the batch did not answer', async () => {
    const { store, budget, log } = setup();
    const { client, calls } = fakeClient({
      answer: () => 'no',
      batchResults: (requests) =>
        requests.map((item) =>
          item.prompt === 'b'
            ? { custom_id: item.custom_id, result: { type: 'errored' } }
            : {
                custom_id: item.custom_id,
                result: { type: 'succeeded', message: message('yes') },
              }
        ),
    });
    await judge([request('a'), request('b')], {
      client,
      batch: true,
      budget,
      store,
      concurrency: 2,
      log,
      pollMs: 0,
    });
    expect(calls.direct).toEqual(['b']);
    expect(store.replies.get('a')?.text).toBe('yes');
    expect(store.replies.get('b')).toEqual({ text: 'no', costUsd: callCost(1000, 10) });
  });

  it('leaves a failed request unjudged and goes on with the rest', async () => {
    const { store, budget, lines, log } = setup();
    const { client } = fakeClient({ answer: () => 'yes', failDirect: (p) => p === 'b' });
    await judge([request('a'), request('b'), request('c')], {
      client,
      batch: false,
      budget,
      store,
      concurrency: 1,
      log,
    });
    expect([...store.replies.keys()].sort()).toEqual(['a', 'c']);
    expect(lines.some((line) => line.includes('1 judge requests failed'))).toBe(true);
  });

  it('collects a batch an earlier run left open and never asks twice', async () => {
    const { dir, budget, log } = setup();
    const { client, calls, batches } = fakeClient({ answer: () => 'yes' });
    batches.set('earlier', [
      { custom_id: 'j0', result: { type: 'succeeded', message: message('yes') } },
    ]);
    const first = new JudgeStore(join(dir, 'replies.jsonl'), join(dir, 'batches.json'));
    first.record('done', { text: 'no', costUsd: 0 });
    first.addBatch({ id: 'earlier', requests: { j0: 'a' }, done: false });

    const store = new JudgeStore(join(dir, 'replies.jsonl'), join(dir, 'batches.json'));
    await judge([request('a'), request('done'), request('new')], {
      client,
      batch: true,
      budget,
      store,
      concurrency: 1,
      log,
      pollMs: 0,
    });
    expect(calls.retrieved[0]).toBe('earlier');
    expect(calls.batches).toEqual([['new']]);
    expect(store.replies.get('a')?.text).toBe('yes');
    expect(store.replies.get('done')?.text).toBe('no');
    expect(store.openBatches).toEqual([]);
  });
});

describe('command line options', () => {
  it('takes positive numbers and integers only', () => {
    expect(positive('budget', '2.5')).toBe(2.5);
    expect(positive('concurrency', '6', true)).toBe(6);
    for (const bad of ['0', '-1', 'NaN', 'Infinity', 'abc', '']) {
      expect(() => positive('budget', bad)).toThrow(UsageError);
    }
    expect(() => positive('concurrency', '1.5', true)).toThrow(UsageError);
  });

  it('reads sample sizes and refuses a malformed pair', () => {
    expect(parseSample('beam-1m=200, locomo=100')).toEqual(
      new Map([
        ['beam-1m', 200],
        ['locomo', 100],
      ])
    );
    expect(parseSample(undefined).size).toBe(0);
    expect(() => parseSample('beam-1m')).toThrow(UsageError);
    expect(() => parseSample('beam-1m=0')).toThrow(UsageError);
    expect(() => parseSample('a=1=2')).toThrow(UsageError);
  });

  it('refuses an unknown name in a list', () => {
    expect(pick('strategies', 'recent, hybrid', ['recent', 'relevant', 'hybrid'])).toEqual([
      'recent',
      'hybrid',
    ]);
    expect(() => pick('strategies', 'recnet', ['recent'])).toThrow(/unknown recnet/);
  });

  it('resumes from the last answer per question, a line cut short skipped', async () => {
    const path = join(tempDir(), 'answers.jsonl');
    const answer = (output: string, error?: string) =>
      ({
        dataset: 'locomo',
        questionId: 'q1',
        strategy: 'recent',
        output,
        ...(error && { error }),
      }) as BenchAnswer;
    writeFileSync(
      path,
      `${JSON.stringify(answer('', 'timeout'))}\n${JSON.stringify(answer('Paris'))}\n{"dataset":"loc`
    );
    const records = await readJsonl<BenchAnswer>(path);
    expect(records).toHaveLength(2);
    expect([...latest(records).values()].map((record) => record.output)).toEqual(['Paris']);
    expect(await readJsonl(join(tempDir(), 'missing.jsonl'))).toEqual([]);
  });
});
