import { expect } from 'vitest';
import type { LLMJudge } from './judge';

let _judge: LLMJudge | null | undefined;
let _judgeInitialized = false;

export function setJudge(judge: LLMJudge | null): void {
  _judge = judge;
  _judgeInitialized = true;
}

export async function expectJudge(
  output: string,
  opts: { question: string; criteria: string }
): Promise<void> {
  if (!_judgeInitialized) {
    throw new Error('Call setJudge() in beforeAll before using expectJudge');
  }
  if (!_judge) {
    console.warn(`[SKIP JUDGE] No GOOGLE_API_KEY — skipping: "${opts.criteria}"`);
    return;
  }

  const result = await _judge.evaluate({
    question: opts.question,
    answer: output,
    criteria: opts.criteria,
  });

  expect(result.pass, `Judge failed: ${result.reason}\nAnswer was: "${output}"`).toBe(true);
}

export function expectValidTimestamp(ts: string): void {
  const date = new Date(ts);
  expect(date.getTime()).not.toBeNaN();
  const now = Date.now();
  const diff = now - date.getTime();
  expect(diff).toBeLessThan(120_000);
  expect(diff).toBeGreaterThanOrEqual(0);
}
