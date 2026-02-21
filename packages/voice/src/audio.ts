export function float32ToPcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buffer;
}

export function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  const samples = new Float32Array(buffer.length / 2);
  for (let i = 0; i < samples.length; i++) {
    const val = view.getInt16(i * 2, true);
    samples[i] = val < 0 ? val / 0x8000 : val / 0x7fff;
  }
  return samples;
}

export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const header = Buffer.alloc(44);
  const view = new DataView(header.buffer);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  view.setUint32(4, 36 + pcm.length, true);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  header.write('data', 36);
  view.setUint32(40, pcm.length, true);

  return Buffer.concat([header, pcm]);
}

export function wavToPcm(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV file');
  }
  const view = new DataView(wav.buffer, wav.byteOffset);
  const sampleRate = view.getUint32(24, true);
  const dataOffset = 44;
  const pcmData = wav.subarray(dataOffset);
  return { samples: pcm16ToFloat32(pcmData), sampleRate };
}

export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return new Float32Array(samples);
  const ratio = fromRate / toRate;
  const outputLength = Math.round(samples.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const floor = Math.floor(srcIndex);
    const frac = srcIndex - floor;
    const a = samples[floor] ?? 0;
    const b = samples[Math.min(floor + 1, samples.length - 1)] ?? 0;
    output[i] = a + frac * (b - a);
  }
  return output;
}

export function calculateRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
