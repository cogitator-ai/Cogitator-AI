import { describe, it, expect } from 'vitest';
import {
  MULAW_SILENCE,
  float32ToMulaw,
  linearToMulaw,
  mulawToFloat32,
  mulawToLinear,
  mulawToPcm16,
  pcm16ToMulaw,
} from '../codec';

/** The μ-law compressor of the ITU-T G.191 software tools (`ulaw_compress`), on 16-bit input */
function itu191Compress(sample: number): number {
  let absno = sample < 0 ? (~sample >> 2) + 33 : (sample >> 2) + 33;
  if (absno > 0x1fff) absno = 0x1fff;
  let segno = 1;
  for (let i = absno >> 6; i !== 0; i >>= 1) segno++;
  const high = 0x8 - segno;
  const low = 0xf - ((absno >> segno) & 0xf);
  return ((high << 4) | low | (sample >= 0 ? 0x80 : 0)) & 0xff;
}

describe('G.711 μ-law', () => {
  it('encodes every 16-bit sample like the ITU-T G.191 reference', () => {
    let mismatches = 0;
    for (let sample = -32768; sample <= 32767; sample++) {
      if (linearToMulaw(sample) !== itu191Compress(sample)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('encodes the reference values', () => {
    expect(linearToMulaw(0)).toBe(MULAW_SILENCE);
    expect(linearToMulaw(-1)).toBe(0x7f);
    expect(linearToMulaw(32767)).toBe(0x80);
    expect(linearToMulaw(-32768)).toBe(0x00);
    expect(linearToMulaw(32635)).toBe(0x80);
    expect(linearToMulaw(1000)).toBe(0xce);
    expect(linearToMulaw(-1000)).toBe(0x4e);
  });

  it('decodes the reference values', () => {
    expect(mulawToLinear(0xff)).toBe(0);
    expect(mulawToLinear(0x7f)).toBe(0);
    expect(mulawToLinear(0x80)).toBe(32124);
    expect(mulawToLinear(0x00)).toBe(-32124);
    expect(mulawToLinear(0xce)).toBe(988);
    expect(mulawToLinear(0x4e)).toBe(-988);
  });

  it('decodes and encodes every code back to itself, but negative zero', () => {
    for (let code = 0; code < 256; code++) {
      expect(linearToMulaw(mulawToLinear(code))).toBe(code === 0x7f ? MULAW_SILENCE : code);
    }
  });

  it('keeps the round-trip error within the quantization step of each segment', () => {
    for (let sample = -32768; sample <= 32767; sample++) {
      const clipped = Math.sign(sample) * Math.min(Math.abs(sample), 32635);
      const error = Math.abs(mulawToLinear(linearToMulaw(sample)) - clipped);
      if (Math.abs(sample) < 256) expect(error).toBeLessThanOrEqual(8);
      else expect(error / Math.abs(clipped)).toBeLessThan(0.0625);
    }
  });

  it('is monotonic', () => {
    let previous = -Infinity;
    for (let sample = -32768; sample <= 32767; sample += 7) {
      const decoded = mulawToLinear(linearToMulaw(sample));
      expect(decoded).toBeGreaterThanOrEqual(previous);
      previous = decoded;
    }
  });

  it('converts PCM16 and float buffers', () => {
    const pcm = Buffer.alloc(8);
    [0, 1000, -1000, 32767].forEach((value, i) => pcm.writeInt16LE(value, i * 2));
    const mulaw = pcm16ToMulaw(pcm);
    expect([...mulaw]).toEqual([0xff, 0xce, 0x4e, 0x80]);
    const back = mulawToPcm16(mulaw);
    expect([0, 1, 2, 3].map((i) => back.readInt16LE(i * 2))).toEqual([0, 988, -988, 32124]);

    const floats = mulawToFloat32(float32ToMulaw(new Float32Array([0, 0.5, -0.5, 1, -1])));
    expect(floats[0]).toBe(0);
    expect(floats[1]).toBeCloseTo(0.5, 1);
    expect(floats[2]).toBeCloseTo(-0.5, 1);
    expect(floats[3]).toBeCloseTo(0.98, 2);
    expect(floats[4]).toBeCloseTo(-0.98, 2);
  });

  it('ignores a trailing odd byte of PCM16', () => {
    expect(pcm16ToMulaw(Buffer.from([0, 0, 1]))).toHaveLength(1);
  });
});
