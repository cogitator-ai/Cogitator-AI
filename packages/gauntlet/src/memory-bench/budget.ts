import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelPriceConfig } from '@cogitator-ai/types';

/** The model every stage of the stand runs on: answers and the judge, fixed so runs compare. */
export const BENCH_MODEL = 'claude-haiku-5-5';

/**
 * USD per million tokens of `claude-haiku-5-5` for prompts up to 100K tokens. Cache prices are
 * the usual 0.1x and 1.25x of input.
 */
export const BENCH_PRICE: ModelPriceConfig = {
  input: 0.1,
  output: 0.5,
  inputCached: 0.01,
  inputCacheWrite: 0.125,
};

/** Prompts above this many tokens cost five times as much on `claude-haiku-5-5`. */
export const LONG_PROMPT_TOKENS = 100_000;

/** The Message Batches API halves the price. */
export const BATCH_DISCOUNT = 0.5;

/** USD per million tokens of `gemini-embedding-001`. */
export const EMBEDDING_PRICE = 0.15;

/** USD of a call with these tokens at the bench prices. */
export function callCost(inputTokens: number, outputTokens: number, batch = false): number {
  const long = inputTokens > LONG_PROMPT_TOKENS ? 5 : 1;
  const usd = ((inputTokens * BENCH_PRICE.input + outputTokens * BENCH_PRICE.output) * long) / 1e6;
  return batch ? usd * BATCH_DISCOUNT : usd;
}

interface LedgerEntry {
  at: string;
  run: string;
  stage: string;
  usd: number;
}

/** A run went over the money it may spend. */
export class BudgetExceededError extends Error {
  constructor(
    readonly limitUsd: number,
    readonly spentUsd: number
  ) {
    super(`Budget of $${limitUsd.toFixed(2)} reached ($${spentUsd.toFixed(4)} spent)`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * What a run may spend and what it spent, by stage, kept in a ledger file next to the results so
 * spending across runs adds up. `charge` records a cost, `reserve` refuses work its estimate
 * would take over the limit.
 */
export class Budget {
  private spent = 0;
  private readonly entries: LedgerEntry[];

  constructor(
    readonly limitUsd: number,
    private readonly run: string,
    private readonly ledgerPath: string
  ) {
    this.entries = existsSync(ledgerPath)
      ? (JSON.parse(readFileSync(ledgerPath, 'utf8')) as LedgerEntry[])
      : [];
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** What every run in the ledger spent, this one included. */
  get ledgerUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.usd, 0);
  }

  reserve(estimateUsd: number): void {
    if (this.spent + estimateUsd > this.limitUsd) {
      throw new BudgetExceededError(this.limitUsd, this.spent);
    }
  }

  charge(stage: string, usd: number): void {
    if (usd <= 0) return;
    this.spent += usd;
    const last = this.entries.at(-1);
    if (last?.run === this.run && last.stage === stage) last.usd += usd;
    else this.entries.push({ at: new Date().toISOString(), run: this.run, stage, usd });
  }

  byStage(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const entry of this.entries) {
      if (entry.run === this.run) totals[entry.stage] = (totals[entry.stage] ?? 0) + entry.usd;
    }
    return totals;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true });
    await writeFile(this.ledgerPath, `${JSON.stringify(this.entries, null, 2)}\n`);
  }
}
