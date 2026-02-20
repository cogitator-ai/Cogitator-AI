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
    return new Dataset(this._cases.filter(fn) as EvalCase[]);
  }

  sample(n: number): Dataset {
    if (n <= 0 || this._cases.length === 0) {
      return new Dataset([]);
    }
    const count = Math.min(n, this._cases.length);
    const indices = Array.from({ length: this._cases.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return new Dataset(indices.slice(0, count).map((i) => this._cases[i]) as EvalCase[]);
  }

  shuffle(): Dataset {
    const arr = [...this._cases] as EvalCase[];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return new Dataset(arr);
  }
}
