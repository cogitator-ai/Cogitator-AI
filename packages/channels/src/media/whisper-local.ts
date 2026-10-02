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
    const jsCache = join(this.modelDir, 'Xenova', 'whisper-tiny', 'onnx');
    if (existsSync(jsCache)) return true;

    const pyCache = join(this.modelDir, 'models--Xenova--whisper-tiny', 'snapshots');
    if (existsSync(pyCache)) {
      try {
        return readdirSync(pyCache).length > 0;
      } catch {
        return false;
      }
    }

    return false;
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

    const pcmFloat32 = await this.decode(audioBuffer, mimeType);

    const pipe = this.pipeline as {
      model: {
        config: { decoder_start_token_id: number };
        generation_config: { no_timestamps_token_id: number };
      };
      (input: Float32Array, opts?: Record<string, unknown>): Promise<{ text: string }>;
    };

    const startToken = pipe.model.config.decoder_start_token_id;
    const noTsToken = pipe.model.generation_config.no_timestamps_token_id;

    const result = await pipe(pcmFloat32, {
      decoder_input_ids: [startToken, noTsToken],
    });
    return result.text.trim();
  }

  private async decode(buffer: Buffer, mimeType: string): Promise<Float32Array> {
    const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mime === 'audio/wav' || mime === 'audio/wave' || mime === 'audio/x-wav') {
      return this.decodeWav(buffer);
    }
    if (
      mime === 'audio/ogg' ||
      mime === 'audio/opus' ||
      buffer.subarray(0, 4).toString() === 'OggS'
    ) {
      return this.decodeOgg(buffer);
    }
    if (buffer.subarray(0, 4).toString() === 'RIFF') {
      return this.decodeWav(buffer);
    }
    throw new Error(
      `Local Whisper supports only OGG/Opus and WAV audio (got ${mimeType}). Configure a cloud STT provider for other formats.`
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (!this.loading) {
      this.loading = (async () => {
        const transformers = await this.loadTransformers();
        const { env, pipeline } = transformers as {
          env: { cacheDir: string; allowLocalModels: boolean };
          pipeline: (
            task: string,
            model: string,
            opts?: Record<string, unknown>
          ) => Promise<unknown>;
        };

        env.cacheDir = this.modelDir;
        env.allowLocalModels = true;

        this.pipeline = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
          dtype: 'q8',
        });
      })();
    }

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
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
    try {
      await decoder.ready;
      const result = await decoder.decode(new Uint8Array(buffer));
      const samples = result.channelData[0];
      if (!samples) throw new Error('OGG stream contains no audio');
      if (result.sampleRate === SAMPLE_RATE) return samples;
      return this.resample(samples, result.sampleRate, SAMPLE_RATE);
    } finally {
      decoder.free();
    }
  }

  private decodeWav(buffer: Buffer): Float32Array {
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
      throw new Error('Invalid WAV file: missing RIFF header');
    }

    let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null =
      null;
    let dataOffset = -1;
    let dataSize = 0;

    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ') {
        format = {
          audioFormat: buffer.readUInt16LE(body),
          channels: buffer.readUInt16LE(body + 2),
          sampleRate: buffer.readUInt32LE(body + 4),
          bits: buffer.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        dataOffset = body;
        dataSize = Math.min(size, buffer.length - body);
        break;
      }
      offset = body + size + (size % 2);
    }

    if (!format || dataOffset < 0) throw new Error('Invalid WAV file: missing fmt or data chunk');

    const { audioFormat, channels, sampleRate, bits } = format;
    const bytesPerSample = bits / 8;
    const isFloat = audioFormat === 3;
    if (![8, 16, 24, 32].includes(bits) || channels < 1) {
      throw new Error(`Unsupported WAV format: ${bits}-bit, ${channels} channel(s)`);
    }

    const frameSize = bytesPerSample * channels;
    const frames = Math.floor(dataSize / frameSize);
    const samples = new Float32Array(frames);

    const readSample = (pos: number): number => {
      if (isFloat && bits === 32) return buffer.readFloatLE(pos);
      switch (bits) {
        case 8:
          return (buffer.readUInt8(pos) - 128) / 128;
        case 16:
          return buffer.readInt16LE(pos) / 32768;
        case 24:
          return buffer.readIntLE(pos, 3) / 8388608;
        default:
          return buffer.readInt32LE(pos) / 2147483648;
      }
    };

    for (let i = 0; i < frames; i++) {
      const frameStart = dataOffset + i * frameSize;
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += readSample(frameStart + c * bytesPerSample);
      }
      samples[i] = sum / channels;
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
