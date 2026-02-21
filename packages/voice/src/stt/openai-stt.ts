import { EventEmitter } from 'node:events';
import OpenAI from 'openai';
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
    const file = new File([audio], 'audio.wav', { type: 'audio/wav' });

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
    return new OpenAISTTStream(this, options);
  }

  _transcribeBuffer(audio: Buffer, options?: STTOptions): Promise<TranscribeResult> {
    return this.transcribe(audio, options);
  }

  private mapResponse(response: Record<string, unknown>): TranscribeResult {
    const result: TranscribeResult = {
      text: response.text as string,
    };

    if (response.language) {
      result.language = response.language as string;
    }

    if (response.duration !== undefined) {
      result.duration = response.duration as number;
    }

    if (Array.isArray(response.words) && response.words.length > 0) {
      result.words = response.words.map(
        (w: { word: string; start: number; end: number; confidence?: number }) => ({
          word: w.word,
          start: w.start,
          end: w.end,
          confidence: w.confidence ?? 1,
        })
      );
    }

    return result;
  }
}

class OpenAISTTStream extends EventEmitter implements STTStream {
  private chunks: Buffer[] = [];
  private readonly provider: OpenAISTT;
  private readonly options?: STTStreamOptions;

  constructor(provider: OpenAISTT, options?: STTStreamOptions) {
    super();
    this.provider = provider;
    this.options = options;
  }

  write(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  async close(): Promise<TranscribeResult> {
    const combined = Buffer.concat(this.chunks);

    try {
      const result = await this.provider._transcribeBuffer(combined, this.options);
      this.emit('final', result);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      throw error;
    }
  }

  on(event: 'partial', cb: (text: string) => void): this;
  on(event: 'final', cb: (result: TranscribeResult) => void): this;
  on(event: 'error', cb: (error: Error) => void): this;
  on(event: string, cb: (...args: unknown[]) => void): this {
    return super.on(event, cb);
  }

  off(event: string, cb: (...args: unknown[]) => void): this {
    return super.off(event, cb);
  }

  removeAllListeners(): this {
    return super.removeAllListeners();
  }
}
