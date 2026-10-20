import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** A run went over the money it may spend. `ledger` names the budget that refused. */
export class BudgetExceededError extends Error {
  constructor(
    readonly limitUsd: number,
    readonly spentUsd: number,
    readonly ledger: string
  ) {
    super(`Budget of $${limitUsd.toFixed(2)} reached ($${spentUsd.toFixed(4)} spent)`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * The budget refusal behind `error`, also when the runtime wrapped it as the `cause` of its own
 * error (a memory error wraps what the embedding service threw).
 */
export function budgetRefusal(error: unknown): BudgetExceededError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof BudgetExceededError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

/** How long a ledger lock may be held before another process takes it as left by a crash. */
const STALE_LOCK_MS = 30_000;

/**
 * Runs `work` while holding `${path}.lock`, so processes sharing a ledger read and replace it one
 * at a time.
 */
async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const held = await stat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * What a run may spend and what it spent, by stage, kept in a ledger file so spending across
 * runs adds up and a resumed run starts from what it already spent. `reserve` holds the estimate
 * of work in flight and refuses work that would take the run over its limit, the returned
 * function lets the hold go once the work's real cost is charged.
 */
export class Budget {
  private spent: number;
  private reserved = 0;
  private saving: Promise<void> = Promise.resolve();
  private readonly entries: LedgerEntry[];

  constructor(
    readonly limitUsd: number,
    private readonly run: string,
    /** Path of the ledger file, which also tells budgets apart */
    readonly ledger: string
  ) {
    this.entries = existsSync(ledger)
      ? (JSON.parse(readFileSync(ledger, 'utf8')) as LedgerEntry[])
      : [];
    this.spent = this.entries
      .filter((entry) => entry.run === run)
      .reduce((sum, entry) => sum + entry.usd, 0);
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** What every run in the ledger spent, this one included. */
  get ledgerUsd(): number {
    return this.entries.reduce((sum, entry) => sum + entry.usd, 0);
  }

  /** The error that says this budget refuses more work. */
  refusal(): BudgetExceededError {
    return new BudgetExceededError(this.limitUsd, this.spent, this.ledger);
  }

  /** What is left to reserve: the limit less what was spent and what work in flight holds. */
  get availableUsd(): number {
    return Math.max(0, this.limitUsd - this.spent - this.reserved);
  }

  reserve(estimateUsd: number): () => void {
    if (this.spent + this.reserved + estimateUsd > this.limitUsd) throw this.refusal();
    this.reserved += estimateUsd;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= estimateUsd;
    };
  }

  /**
   * Records a cost and writes the ledger, so a run stopped right after still counts it. A write
   * that fails here is made again by the next one, and an awaited `save` reports it.
   */
  charge(stage: string, usd: number): void {
    if (usd <= 0) return;
    this.spent += usd;
    const last = this.entries.at(-1);
    if (last?.run === this.run && last.stage === stage) last.usd += usd;
    else this.entries.push({ at: new Date().toISOString(), run: this.run, stage, usd });
    this.save().catch(() => undefined);
  }

  byStage(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const entry of this.entries) {
      if (entry.run === this.run) totals[entry.stage] = (totals[entry.stage] ?? 0) + entry.usd;
    }
    return totals;
  }

  /**
   * Writes this run's entries into the ledger, keeping whatever other runs wrote to it since it
   * was read, so runs going at once do not erase each other. Writes go one at a time and replace
   * the file whole, so a reader never sees it half written.
   */
  save(): Promise<void> {
    this.saving = this.saving.then(
      () => this.write(),
      () => this.write()
    );
    return this.saving;
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.ledger), { recursive: true });
    await withLock(this.ledger, async () => {
      const others = existsSync(this.ledger)
        ? (JSON.parse(readFileSync(this.ledger, 'utf8')) as LedgerEntry[]).filter(
            (entry) => entry.run !== this.run
          )
        : [];
      const mine = this.entries.filter((entry) => entry.run === this.run);
      const partial = `${this.ledger}.${process.pid}.tmp`;
      await writeFile(partial, `${JSON.stringify([...others, ...mine], null, 2)}\n`);
      await rename(partial, this.ledger);
    });
  }
}
