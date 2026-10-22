import { EvalCaseSchema } from '../schema';
import type { EvalCase } from '../schema';
import { loadJsonl } from './jsonl-loader';
import { loadCsv } from './csv-loader';

export class Dataset {
  private readonly _cases: readonly EvalCase[];

  private constructor(cases: EvalCase[]) {
    this._cases = Object.freeze(cases.map((c) => EvalCaseSchema.parse(c)));
  }

  static from(cases: EvalCase[]): Dataset {
    return new Dataset(cases);
  }

  static async fromJsonl(path: string): Promise<Dataset> {
    const cases = await loadJsonl(path);
    return Dataset.from(cases);
  }

  static async fromCsv(path: string): Promise<Dataset> {
    const cases = await loadCsv(path);
    return Dataset.from(cases);
  }

  get length(): number {
    return this._cases.length;
  }

  get cases(): readonly EvalCase[] {
    return this._cases;
  }

  [Symbol.iterator](): Iterator<EvalCase> {
    let index = 0;
    const cases = this._cases;
    return {
      next(): IteratorResult<EvalCase> {
        if (index < cases.length) {
          return { value: cases[index++], done: false };
        }
        return { value: undefined as never, done: true };
      },
    };
  }

  filter(fn: (c: EvalCase) => boolean): Dataset {
    return new Dataset(this._cases.filter(fn));
  }

  /**
   * `n` cases picked at random, all of them when `n` is at least the size. With `seed` the pick
   * is the same on every run, so a sampled eval compares like with like
   */
  sample(n: number, options: { seed?: number | string } = {}): Dataset {
    if (n <= 0 || this._cases.length === 0) {
      return new Dataset([]);
    }
    const count = Math.min(n, this._cases.length);
    const indices = shuffled(
      Array.from({ length: this._cases.length }, (_, i) => i),
      randomOf(options.seed)
    );
    return new Dataset(indices.slice(0, count).map((i) => this._cases[i]));
  }

  /** The cases in random order, the same order on every run with `seed` */
  shuffle(options: { seed?: number | string } = {}): Dataset {
    return new Dataset(shuffled([...this._cases], randomOf(options.seed)));
  }
}

/** Shuffles `items` in place (Fisher-Yates) with the random numbers `random` gives */
function shuffled<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * `Math.random`, or a mulberry32 generator seeded by the hash of `seed`, so every number and
 * string seeds its own sequence (`1.2` and `1.7`, `-1` and `2 ** 32 - 1` alike)
 */
function randomOf(seed: number | string | undefined): () => number {
  if (seed === undefined) return Math.random;
  let state = hashSeed(String(seed));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string, to seed the generator */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
