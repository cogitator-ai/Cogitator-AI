import { describe, it, expect } from 'vitest';
import { Resampler, resampleBandLimited } from '../resampler';
import { AudioTranscoder } from '../transcoder';
import { float32ToPcm16, pcm16ToFloat32, resample } from '../audio';
import { float32ToMulaw, mulawToFloat32 } from '../codec';

function tone(frequency: number, rate: number, length: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return samples;
}

/** RMS level in dB relative to a sine of `amplitude`, away from the edges */
function levelDb(samples: Float32Array, amplitude = 0.5, edge = 300): number {
  let sum = 0;
  for (let i = edge; i < samples.length - edge; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / (samples.length - 2 * edge));
  return 20 * Math.log10(rms / (amplitude / Math.SQRT2));
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function streamed(input: Float32Array, from: number, to: number, sizes: number[]): Float32Array {
  const resampler = new Resampler(from, to);
  const parts: Float32Array[] = [];
  let offset = 0;
  for (let i = 0; offset < input.length; i++) {
    const size = sizes[i % sizes.length]!;
    parts.push(resampler.process(input.subarray(offset, offset + size)));
    offset += size;
  }
  parts.push(resampler.flush());
  return concat(parts);
}

describe('Resampler', () => {
  it('keeps the passband of 24k -> 8k and filters out what aliases', () => {
    for (const frequency of [300, 1000, 3000]) {
      const out = resampleBandLimited(tone(frequency, 24000, 24000), 24000, 8000);
      expect(Math.abs(levelDb(out))).toBeLessThan(0.5);
    }
    for (const frequency of [4200, 5000, 6000, 7000, 9000, 11000]) {
      const out = resampleBandLimited(tone(frequency, 24000, 24000), 24000, 8000);
      expect(levelDb(out)).toBeLessThan(-70);
    }
  });

  it('attenuates the energy above 4 kHz of a sine sweep', () => {
    const rate = 24000;
    const length = rate * 2;
    const sweep = new Float32Array(length);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const frequency = 4200 + (7800 * i) / length;
      phase += (2 * Math.PI * frequency) / rate;
      sweep[i] = 0.5 * Math.sin(phase);
    }
    expect(levelDb(resampleBandLimited(sweep, rate, 8000))).toBeLessThan(-60);
    expect(levelDb(resample(sweep, rate, 8000))).toBeLessThan(-60);
  });

  it('downsamples 16k -> 8k without aliasing', () => {
    expect(levelDb(resampleBandLimited(tone(5000, 16000, 16000), 16000, 8000))).toBeLessThan(-70);
    const kept = resampleBandLimited(tone(2000, 16000, 16000), 16000, 8000);
    expect(Math.abs(levelDb(kept))).toBeLessThan(0.5);
  });

  it('interpolates 8k -> 24k and 8k -> 16k in phase with the original', () => {
    for (const to of [16000, 24000]) {
      const out = resampleBandLimited(tone(1000, 8000, 8000), 8000, to);
      expect(out).toHaveLength(to);
      let error = 0;
      for (let i = 600; i < out.length - 600; i++) {
        error = Math.max(error, Math.abs(out[i]! - 0.5 * Math.sin((2 * Math.PI * 1000 * i) / to)));
      }
      expect(error).toBeLessThan(1e-3);
    }
  });

  it('gives the same output whatever the chunk boundaries', () => {
    const input = tone(440, 24000, 24000);
    const whole = resampleBandLimited(input, 24000, 8000);
    for (const sizes of [[1], [137], [160, 1, 7, 480], [24000]]) {
      const out = streamed(input, 24000, 8000, sizes);
      expect(out).toHaveLength(whole.length);
      let difference = 0;
      for (let i = 0; i < out.length; i++) {
        difference = Math.max(difference, Math.abs(out[i]! - whole[i]!));
      }
      expect(difference).toBeLessThan(1e-6);
    }
  });

  it('has no clicks at chunk boundaries', () => {
    const out = streamed(tone(440, 8000, 16000), 8000, 24000, [160, 33, 1]);
    const maxStep = 0.5 * 2 * Math.PI * (440 / 24000);
    for (let i = 600; i < out.length - 600; i++) {
      expect(Math.abs(out[i]! - out[i - 1]!)).toBeLessThan(maxStep * 1.05);
    }
  });

  it('produces ceil(n * to / from) samples over a stream and starts again after flush', () => {
    const resampler = new Resampler(24000, 8000);
    const total = resampler.process(new Float32Array(1000)).length + resampler.flush().length;
    expect(total).toBe(Math.ceil(1000 / 3));
    const again = resampler.process(new Float32Array(999)).length + resampler.flush().length;
    expect(again).toBe(333);
  });

  it('handles rates without a small common divisor', () => {
    const out = resampleBandLimited(tone(1000, 44100, 4410), 44100, 16001);
    expect(out).toHaveLength(Math.round((4410 * 16001) / 44100));
    expect(Math.abs(levelDb(out, 0.5, 200))).toBeLessThan(0.5);
  });

  it('rejects rates that are not positive integers', () => {
    expect(() => new Resampler(0, 8000)).toThrow(RangeError);
    expect(() => new Resampler(8000, 22050.5)).toThrow(RangeError);
    expect(() => new Resampler(8000, 16000, { rolloff: 1.5 })).toThrow(RangeError);
  });

  it('runs in linear time', () => {
    const time = (seconds: number): number => {
      const input = tone(440, 24000, 24000 * seconds);
      const started = performance.now();
      resampleBandLimited(input, 24000, 8000);
      return performance.now() - started;
    };
    time(1);
    const short = time(15);
    const long = time(60);
    expect(long / short).toBeLessThan(10);
  });
});

describe('resample', () => {
  it('keeps the old output length and falls back to linear for fractional rates', () => {
    expect(resample(new Float32Array(4800), 48000, 16000)).toHaveLength(1600);
    expect(resample(new Float32Array(100), 8000.5, 16001)).toHaveLength(200);
  });
});

describe('AudioTranscoder', () => {
  it('turns 24 kHz PCM16 into 8 kHz μ-law and back, joining samples cut between chunks', () => {
    const pcm = float32ToPcm16(tone(1000, 24000, 4800));
    const down = new AudioTranscoder(
      { encoding: 'pcm16', sampleRate: 24000 },
      { encoding: 'mulaw', sampleRate: 8000 }
    );
    const parts: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += 333) {
      parts.push(down.push(pcm.subarray(offset, offset + 333)));
    }
    parts.push(down.flush());
    const mulaw = Buffer.concat(parts);
    expect(mulaw).toHaveLength(1600);

    const direct = float32ToMulaw(resampleBandLimited(pcm16ToFloat32(pcm), 24000, 8000));
    expect(mulaw.equals(direct)).toBe(true);

    const up = new AudioTranscoder(
      { encoding: 'mulaw', sampleRate: 8000 },
      { encoding: 'pcm16', sampleRate: 24000 }
    );
    const back = pcm16ToFloat32(Buffer.concat([up.push(mulaw), up.flush()]));
    expect(back).toHaveLength(4800);
    expect(Math.abs(levelDb(back, 0.5, 600))).toBeLessThan(0.5);
  });

  it('passes audio through when the formats match', () => {
    const format = { encoding: 'mulaw', sampleRate: 8000 } as const;
    const chunk = Buffer.from([1, 2, 3]);
    expect(new AudioTranscoder(format, format).push(chunk)).toBe(chunk);
  });

  it('only re-encodes at the same rate', () => {
    const codec = new AudioTranscoder(
      { encoding: 'mulaw', sampleRate: 8000 },
      { encoding: 'pcm16', sampleRate: 8000 }
    );
    const mulaw = float32ToMulaw(tone(500, 8000, 80));
    const pcm = codec.push(mulaw);
    expect(pcm).toHaveLength(160);
    expect(mulawToFloat32(mulaw)).toEqual(pcm16ToFloat32(pcm));
    expect(codec.flush()).toHaveLength(0);
  });
});
