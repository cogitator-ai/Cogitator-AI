import { EventEmitter } from 'node:events';
import OpenAI from 'openai';
import type { TranscriptionVerbose } from 'openai/resources/audio/transcriptions';
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

const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';

export class OpenAISTT implements STTProvider {
  readonly name = 'openai';

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAISTTConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async transcribe(audio: Buffer, options?: STTOptions): Promise<TranscribeResult> {
    const file = new File([new Uint8Array(audio)], 'audio.wav', { type: 'audio/wav' });

    const response = await this.client.audio.transcriptions.create({
      file,
      model: this.model,
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
      ...(options?.language && { language: options.language }),
      ...(options?.prompt && { prompt: options.prompt }),
    });

    return this.mapResponse(response);
  }

  createStream(options?: STTStreamOptions): STTStream {
    return new OpenAISTTStream((audio, opts) => this.transcribe(audio, opts), options);
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
  private readonly transcribeFn: TranscribeFn;
  private readonly options?: STTStreamOptions;

  constructor(transcribeFn: TranscribeFn, options?: STTStreamOptions) {
    super();
    this.transcribeFn = transcribeFn;
    this.options = options;
  }

  write(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  async close(): Promise<TranscribeResult> {
    const combined = Buffer.concat(this.chunks);
    this.chunks = [];

    try {
      const result = await this.transcribeFn(combined, this.options);
      this.emit('final', result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      throw error;
    }
  }
}
