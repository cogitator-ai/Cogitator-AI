import { float32ToPcm16, pcm16ToFloat32 } from './audio.js';
import { float32ToMulaw, mulawToFloat32 } from './codec.js';
import { Resampler } from './resampler.js';
import type { RawAudioFormat } from './types.js';

function decode(chunk: Buffer, format: RawAudioFormat): Float32Array {
  return format.encoding === 'mulaw' ? mulawToFloat32(chunk) : pcm16ToFloat32(chunk);
}

function encode(samples: Float32Array, format: RawAudioFormat): Buffer {
  return format.encoding === 'mulaw' ? float32ToMulaw(samples) : float32ToPcm16(samples);
}

/** True when the two formats describe the same bytes */
export function sameAudioFormat(a: RawAudioFormat, b: RawAudioFormat): boolean {
  return a.encoding === b.encoding && a.sampleRate === b.sampleRate;
}

/**
 * Converts a stream of raw audio between encodings and rates, chunk by chunk: a PCM16 sample cut
 * between two chunks is joined, and the resampler keeps its state across chunks. `flush` ends the
 * stream (the resampler's tail) and leaves the transcoder ready for a new one.
 */
export class AudioTranscoder {
  private readonly resampler: Resampler | null;
  private readonly passthrough: boolean;
  private carry: Buffer | null = null;

  constructor(
    readonly from: RawAudioFormat,
    readonly to: RawAudioFormat
  ) {
    this.passthrough = sameAudioFormat(from, to);
    this.resampler =
      from.sampleRate === to.sampleRate ? null : new Resampler(from.sampleRate, to.sampleRate);
  }

  push(chunk: Buffer): Buffer {
    if (this.passthrough) return chunk;
    const input = this.align(chunk);
    if (input.length === 0) return Buffer.alloc(0);
    const samples = decode(input, this.from);
    return encode(this.resampler ? this.resampler.process(samples) : samples, this.to);
  }

  flush(): Buffer {
    this.carry = null;
    if (this.passthrough || !this.resampler) return Buffer.alloc(0);
    return encode(this.resampler.flush(), this.to);
  }

  /** Drops the stream's state without its tail */
  reset(): void {
    this.carry = null;
    this.resampler?.reset();
  }

  private align(chunk: Buffer): Buffer {
    if (this.from.encoding !== 'pcm16') return chunk;
    const joined = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const even = joined.length & ~1;
    this.carry = even < joined.length ? Buffer.from(joined.subarray(even)) : null;
    return joined.subarray(0, even);
  }
}
