import { EvalCaseSchema } from '../schema';
import type { EvalCase } from '../schema';
import { loadJsonl } from './jsonl-loader';
import { loadCsv } from './csv-loader';
import { seededRandom } from '../stats/random';

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
      seededRandom(options.seed)
    );
    return new Dataset(indices.slice(0, count).map((i) => this._cases[i]));
  }

  /** The cases in random order, the same order on every run with `seed` */
  shuffle(options: { seed?: number | string } = {}): Dataset {
    return new Dataset(shuffled([...this._cases], seededRandom(options.seed)));
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
