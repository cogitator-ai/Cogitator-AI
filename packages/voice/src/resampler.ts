/**
 * Band-limited sample rate conversion: a Kaiser-windowed sinc low-pass evaluated in polyphase
 * form, so downsampling filters out what the new rate cannot hold instead of folding it back as
 * aliasing, and upsampling interpolates with the same filter.
 */

const ZERO_CROSSINGS = 32;
const ROLLOFF = 0.9;
const KAISER_BETA = 8.6;
const MAX_TABLE_PHASES = 1024;

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 50; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

function assertRate(name: string, rate: number): void {
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${rate}`);
  }
}

export interface ResamplerOptions {
  /**
   * Where the low-pass sits, as a fraction of the lower rate's Nyquist frequency (default 0.9,
   * 3.6 kHz for 8 kHz audio). The stopband begins just below Nyquist.
   */
  rolloff?: number;
}

/**
 * Converts a stream of float samples from one rate to another. Feed it chunks of any size with
 * `process` and call `flush` at the end of the stream for the samples the filter still holds:
 * the filter's state carries across chunks, so chunk boundaries leave no clicks, and the output
 * is aligned with the input (the filter's delay is compensated). The cost is linear in the
 * number of samples.
 */
export class Resampler {
  readonly fromRate: number;
  readonly toRate: number;
  private readonly up: number;
  private readonly down: number;
  private readonly cutoff: number;
  private readonly halfWidth: number;
  private readonly taps: number;
  private readonly table: Float32Array[] | null;
  private readonly i0Beta = besselI0(KAISER_BETA);
  private history: Float32Array;
  private historyStart = 0;
  private historyLength = 0;
  private consumed = 0;
  private produced = 0;

  constructor(fromRate: number, toRate: number, options: ResamplerOptions = {}) {
    assertRate('fromRate', fromRate);
    assertRate('toRate', toRate);
    const rolloff = options.rolloff ?? ROLLOFF;
    if (!(rolloff > 0 && rolloff <= 1)) {
      throw new RangeError(`rolloff must be in (0, 1], got ${rolloff}`);
    }
    const divisor = gcd(fromRate, toRate);
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.up = toRate / divisor;
    this.down = fromRate / divisor;
    this.cutoff = (rolloff * Math.min(1, toRate / fromRate)) / 2;
    this.halfWidth = ZERO_CROSSINGS / (2 * this.cutoff);
    this.taps = Math.ceil(this.halfWidth);
    this.table = this.up <= MAX_TABLE_PHASES ? this.buildTable() : null;
    this.history = new Float32Array(Math.max(1024, 4 * this.taps));
  }

  /** The output samples the input so far makes available */
  process(samples: Float32Array): Float32Array {
    this.append(samples);
    return this.emit(false);
  }

  /** The samples still held back by the filter, the rest of the input taken as silence */
  flush(): Float32Array {
    const out = this.emit(true);
    this.reset();
    return out;
  }

  /** Drops the stream's state, to start a new stream */
  reset(): void {
    this.historyStart = 0;
    this.historyLength = 0;
    this.consumed = 0;
    this.produced = 0;
  }

  private kernel(offset: number): number {
    const ratio = offset / this.halfWidth;
    if (ratio <= -1 || ratio >= 1) return 0;
    const x = 2 * this.cutoff * offset;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const window = besselI0(KAISER_BETA * Math.sqrt(1 - ratio * ratio)) / this.i0Beta;
    return 2 * this.cutoff * sinc * window;
  }

  private weights(phase: number): Float32Array {
    const fraction = phase / this.up;
    const weights = new Float32Array(2 * this.taps);
    let sum = 0;
    for (let j = 0; j < weights.length; j++) {
      const value = this.kernel(j - this.taps + 1 - fraction);
      weights[j] = value;
      sum += value;
    }
    for (let j = 0; j < weights.length; j++) weights[j]! /= sum;
    return weights;
  }

  private buildTable(): Float32Array[] {
    const table: Float32Array[] = [];
    for (let phase = 0; phase < this.up; phase++) table.push(this.weights(phase));
    return table;
  }

  private append(samples: Float32Array): void {
    const needed = this.historyLength + samples.length;
    if (needed > this.history.length) {
      const grown = new Float32Array(Math.max(needed, this.history.length * 2));
      grown.set(this.history.subarray(0, this.historyLength));
      this.history = grown;
    }
    this.history.set(samples, this.historyLength);
    this.historyLength += samples.length;
    this.consumed += samples.length;
  }

  private emit(final: boolean): Float32Array {
    const total = final
      ? Math.ceil((this.consumed * this.up) / this.down)
      : Math.max(0, Math.ceil(((this.consumed - this.taps) * this.up) / this.down));
    const count = Math.max(0, total - this.produced);
    const out = new Float32Array(count);
    const span = 2 * this.taps;
    for (let k = 0; k < count; k++) {
      const n = this.produced + k;
      const position = n * this.down;
      const base = Math.floor(position / this.up);
      const phase = position - base * this.up;
      const weights = this.table ? this.table[phase]! : this.weights(phase);
      const first = base - this.taps + 1;
      let acc = 0;
      for (let j = 0; j < span; j++) {
        const index = first + j - this.historyStart;
        if (index < 0 || index >= this.historyLength) continue;
        acc += weights[j]! * this.history[index]!;
      }
      out[k] = acc;
    }
    this.produced += count;
    this.trim();
    return out;
  }

  /** Forgets the input the next output samples no longer reach */
  private trim(): void {
    const nextBase = Math.floor((this.produced * this.down) / this.up);
    const keepFrom = Math.max(this.historyStart, nextBase - this.taps + 1);
    const drop = Math.min(keepFrom - this.historyStart, this.historyLength);
    if (drop <= 0) return;
    this.history.copyWithin(0, drop, this.historyLength);
    this.historyLength -= drop;
    this.historyStart += drop;
  }
}

/**
 * Resamples a whole buffer with the band-limited `Resampler`. The output has
 * `round(samples.length * toRate / fromRate)` samples, and the audio before the first sample and
 * after the last is taken as silence.
 */
export function resampleBandLimited(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
  options?: ResamplerOptions
): Float32Array {
  if (fromRate === toRate) {
    assertRate('fromRate', fromRate);
    return new Float32Array(samples);
  }
  const resampler = new Resampler(fromRate, toRate, options);
  const length = Math.round((samples.length * toRate) / fromRate);
  const head = resampler.process(samples);
  const tail = resampler.flush();
  const out = new Float32Array(length);
  out.set(head.subarray(0, length));
  if (head.length < length) out.set(tail.subarray(0, length - head.length), head.length);
  return out;
}
