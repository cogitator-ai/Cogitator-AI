import { EventEmitter } from 'node:events';
import type {
  TranscriptionCreateParamsNonStreaming,
  TranscriptionVerbose,
} from 'openai/resources/audio/transcriptions';
import { audioMimeType, detectAudioFormat, pcmToWav } from '../audio.js';
import { lazyOpenAIClient, type OpenAIClientFactory } from '../openai-client.js';
import type {
  STTProvider,
  STTOptions,
  STTStreamOptions,
  STTStream,
  TranscribeResult,
} from '../types.js';

export interface OpenAISTTConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
}

const DEFAULT_MODEL = 'gpt-transcribe';
const DEFAULT_SAMPLE_RATE = 16000;

function supportsVerboseJson(model: string): boolean {
  return model.startsWith('whisper');
}

function usesLanguagesList(model: string): boolean {
  return model.startsWith('gpt-transcribe');
}

type JsonTranscriptionParams = TranscriptionCreateParamsNonStreaming<'json'> & {
  languages?: string[];
};

interface JsonTranscription {
  text: string;
  languages?: Array<{ code?: string }>;
}

function toUploadFile(audio: Buffer, sampleRate: number): File {
  const format = detectAudioFormat(audio);
  if (!format) {
    return new File([new Uint8Array(pcmToWav(audio, sampleRate))], 'audio.wav', {
      type: 'audio/wav',
    });
  }
  return new File([new Uint8Array(audio)], `audio.${format}`, { type: audioMimeType(format) });
}

function hasContainerHeader(audio: Buffer): boolean {
  const format = detectAudioFormat(audio);
  if (format === null) return false;
  if (format === 'mp3') return audio.toString('ascii', 0, 3) === 'ID3';
  return true;
}

export class OpenAISTT implements STTProvider {
  readonly name = 'openai';

  private readonly client: OpenAIClientFactory;
  private readonly model: string;

  constructor(config: OpenAISTTConfig) {
    this.client = lazyOpenAIClient({
      apiKey: config.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
    this.model = config.model ?? DEFAULT_MODEL;
  }

  /**
   * Transcribe a complete audio file (wav, mp3, ogg, flac, webm, mp4). Headerless input is
   * treated as raw PCM16 mono at 16kHz and wrapped into a WAV container.
   */
  async transcribe(audio: Buffer, options?: STTOptions): Promise<TranscribeResult> {
    return this.transcribeFile(toUploadFile(audio, DEFAULT_SAMPLE_RATE), options);
  }

  createStream(options?: STTStreamOptions): STTStream {
    const sampleRate = options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    return new OpenAISTTStream((audio, opts) => {
      const file = hasContainerHeader(audio)
        ? toUploadFile(audio, sampleRate)
        : new File([new Uint8Array(pcmToWav(audio, sampleRate))], 'audio.wav', {
            type: 'audio/wav',
          });
      return this.transcribeFile(file, opts);
    }, options);
  }

  private async transcribeFile(file: File, options?: STTOptions): Promise<TranscribeResult> {
    const client = await this.client();
    const prompt = options?.prompt ? { prompt: options.prompt } : {};

    if (supportsVerboseJson(this.model)) {
      const response = await client.audio.transcriptions.create({
        file,
        model: this.model,
        ...(options?.language && { language: options.language }),
        ...prompt,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      });
      return this.mapResponse(response);
    }

    const params: JsonTranscriptionParams = {
      file,
      model: this.model,
      ...prompt,
      response_format: 'json',
    };
    if (options?.language) {
      if (usesLanguagesList(this.model)) {
        params.languages = [options.language];
      } else {
        params.language = options.language;
      }
    }

    const response: JsonTranscription = await client.audio.transcriptions.create(params);
    const result: TranscribeResult = { text: response.text };
    const language = response.languages?.[0]?.code ?? options?.language;
    if (language) result.language = language;
    return result;
  }

  private mapResponse(response: TranscriptionVerbose): TranscribeResult {
    const result: TranscribeResult = {
      text: response.text,
    };

    if (response.language) {
      result.language = response.language;
    }

    if (response.duration !== undefined) {
      result.duration = response.duration;
    }

    if (response.words && response.words.length > 0) {
      result.words = response.words.map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: 1,
      }));
    }

    return result;
  }
}

type TranscribeFn = (audio: Buffer, options?: STTOptions) => Promise<TranscribeResult>;

class OpenAISTTStream extends EventEmitter implements STTStream {
  private chunks: Buffer[] = [];
  private closed = false;
  private closePromise: Promise<TranscribeResult> | null = null;
  private readonly transcribeFn: TranscribeFn;
  private readonly options?: STTStreamOptions;

  constructor(transcribeFn: TranscribeFn, options?: STTStreamOptions) {
    super();
    this.transcribeFn = transcribeFn;
    this.options = options;
  }

  write(chunk: Buffer): void {
    if (this.closed) {
      throw new Error('OpenAISTTStream: cannot write after close');
    }
    this.chunks.push(chunk);
  }

  close(): Promise<TranscribeResult> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.finish();
    }
    return this.closePromise;
  }

  private async finish(): Promise<TranscribeResult> {
    const combined = Buffer.concat(this.chunks);
    this.chunks = [];

    if (combined.length === 0) {
      return { text: '' };
    }

    try {
      const result = await this.transcribeFn(combined, this.options);
      this.emit('final', result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.listenerCount('error') > 0) this.emit('error', error);
      throw error;
    }
  }
}
