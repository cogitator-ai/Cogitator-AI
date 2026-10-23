/**
 * G.711 μ-law, the 8 kHz telephone codec (ITU-T G.711, the reference encoder with a clip at
 * 32635 and a bias of 0x84). One byte holds one sample, silence is 0xFF.
 */

const MULAW_CLIP = 32635;
const MULAW_BIAS = 0x84;

/** The μ-law byte of silence */
export const MULAW_SILENCE = 0xff;

const DECODE_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const byte = ~i & 0xff;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0f;
    const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
    table[i] = byte & 0x80 ? -magnitude : magnitude;
  }
  return table;
})();

const EXPONENT_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let exponent = 0;
    for (let value = i >> 1; value > 0; value >>= 1) exponent++;
    table[i] = exponent;
  }
  return table;
})();

/** Encodes one 16-bit PCM sample to a μ-law byte */
export function linearToMulaw(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, Math.trunc(sample)));
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm += MULAW_BIAS;
  const exponent = EXPONENT_TABLE[(pcm >> 7) & 0xff]!;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decodes one μ-law byte to a 16-bit PCM sample */
export function mulawToLinear(byte: number): number {
  return DECODE_TABLE[byte & 0xff]!;
}

/** Encodes float samples in [-1, 1] to μ-law, one byte a sample */
export function float32ToMulaw(samples: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = linearToMulaw(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff));
  }
  return out;
}

/** Decodes μ-law bytes to float samples in [-1, 1] */
export function mulawToFloat32(mulaw: Buffer): Float32Array {
  const out = new Float32Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    const value = DECODE_TABLE[mulaw[i]!]!;
    out[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return out;
}

/** Encodes little-endian PCM16 to μ-law. A trailing odd byte is ignored */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const count = pcm.length >> 1;
  const out = Buffer.allocUnsafe(count);
  for (let i = 0; i < count; i++) out[i] = linearToMulaw(pcm.readInt16LE(i * 2));
  return out;
}

/** Decodes μ-law to little-endian PCM16 */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) out.writeInt16LE(DECODE_TABLE[mulaw[i]!]!, i * 2);
  return out;
}
