import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WHISPER_MODEL = 'Xenova/whisper-tiny';
const SAMPLE_RATE = 16000;

export class LocalWhisper {
  private pipeline: unknown = null;
  private loading: Promise<void> | null = null;
  readonly modelDir: string;

  constructor(modelDir?: string) {
    this.modelDir = modelDir ?? join(homedir(), '.cogitator', 'models');
  }

  isModelDownloaded(): boolean {
    const cacheDir = join(this.modelDir, 'models--Xenova--whisper-tiny');
    if (!existsSync(cacheDir)) return false;
    try {
      const snapshots = join(cacheDir, 'snapshots');
      if (!existsSync(snapshots)) return false;
      const dirs = readdirSync(snapshots);
      return dirs.length > 0;
    } catch {
      return false;
    }
  }

  async download(): Promise<void> {
    await this.ensureDeps();
    const transformers = await this.loadTransformers();
    const { env, pipeline } = transformers as {
      env: { cacheDir: string; allowLocalModels: boolean };
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
    };

    env.cacheDir = this.modelDir;
    env.allowLocalModels = true;

    console.log(`[whisper] Downloading ${WHISPER_MODEL} to ${this.modelDir}...`);
    this.pipeline = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      dtype: 'q8',
    });
    console.log('[whisper] Model downloaded and ready');
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<string> {
    if (!this.pipeline) {
      await this.ensureLoaded();
    }

    let pcmFloat32: Float32Array;

    if (mimeType === 'audio/ogg' || mimeType === 'audio/opus') {
      pcmFloat32 = await this.decodeOgg(audioBuffer);
    } else if (mimeType === 'audio/wav' || mimeType === 'audio/wave') {
      pcmFloat32 = this.decodeWav(audioBuffer);
    } else {
      pcmFloat32 = await this.decodeOgg(audioBuffer);
    }

    const result = await (this.pipeline as (input: Float32Array) => Promise<{ text: string }>)(
      pcmFloat32
    );
    return result.text.trim();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (this.loading) {
      await this.loading;
      return;
    }

    this.loading = (async () => {
      const transformers = await this.loadTransformers();
      const { env, pipeline } = transformers as {
        env: { cacheDir: string; allowLocalModels: boolean };
        pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      };

      env.cacheDir = this.modelDir;
      env.allowLocalModels = true;

      this.pipeline = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        dtype: 'q8',
      });
    })();

    await this.loading;
    this.loading = null;
  }

  private async ensureDeps(): Promise<void> {
    const missing: string[] = [];
    try {
      await import('@huggingface/transformers' as string);
    } catch {
      missing.push('@huggingface/transformers');
    }
    try {
      await import('ogg-opus-decoder' as string);
    } catch {
      missing.push('ogg-opus-decoder');
    }
    if (missing.length === 0) return;

    console.log(`[whisper] Installing dependencies: ${missing.join(', ')}...`);
    const cmd = `npm install --no-save ${missing.join(' ')}`;
    execSync(cmd, { stdio: 'pipe', timeout: 120_000 });
    console.log('[whisper] Dependencies installed');
  }

  private async loadTransformers(): Promise<unknown> {
    return import('@huggingface/transformers' as string);
  }

  private async decodeOgg(buffer: Buffer): Promise<Float32Array> {
    const mod = (await import('ogg-opus-decoder' as string)) as Record<string, unknown>;

    const OggOpusDecoder = mod.OggOpusDecoder as new () => {
      ready: Promise<void>;
      decode(data: Uint8Array): Promise<{ channelData: Float32Array[]; sampleRate: number }>;
      free(): void;
    };

    const decoder = new OggOpusDecoder();
    await decoder.ready;

    const result = await decoder.decode(new Uint8Array(buffer));
    decoder.free();

    const samples = result.channelData[0];
    if (result.sampleRate === SAMPLE_RATE) return samples;
    return this.resample(samples, result.sampleRate, SAMPLE_RATE);
  }

  private decodeWav(buffer: Buffer): Float32Array {
    const dataOffset = buffer.indexOf('data') + 8;
    const bitsPerSample = buffer.readUInt16LE(34);
    const sampleRate = buffer.readUInt32LE(24);
    const numChannels = buffer.readUInt16LE(22);
    const dataSize = buffer.readUInt32LE(dataOffset - 4);
    const numSamples = dataSize / (bitsPerSample / 8) / numChannels;

    const samples = new Float32Array(numSamples);
    let offset = dataOffset;

    for (let i = 0; i < numSamples; i++) {
      if (bitsPerSample === 16) {
        samples[i] = buffer.readInt16LE(offset) / 32768;
        offset += 2 * numChannels;
      } else if (bitsPerSample === 32) {
        samples[i] = buffer.readFloatLE(offset);
        offset += 4 * numChannels;
      }
    }

    if (sampleRate === SAMPLE_RATE) return samples;
    return this.resample(samples, sampleRate, SAMPLE_RATE);
  }

  private resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = srcIdx - lo;
      result[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
    }
    return result;
  }
}
