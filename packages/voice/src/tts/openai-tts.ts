import OpenAI from 'openai';
import type { SpeechCreateParams } from 'openai/resources/audio/speech';
import type { TTSProvider, TTSOptions, VoiceAudioFormat } from '../types.js';

export interface OpenAITTSConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  baseURL?: string;
}

const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';

function mapFormat(format: VoiceAudioFormat): string {
  if (format === 'pcm16') return 'pcm';
  return format;
}

export class OpenAITTS implements TTSProvider {
  readonly name = 'openai';

  private readonly client: OpenAI;
  private readonly model: string;
  private readonly voice: string;

  constructor(config: OpenAITTSConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
    this.model = config.model ?? DEFAULT_MODEL;
    this.voice = config.voice ?? DEFAULT_VOICE;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    this.validateText(text);
    const response = await this.client.audio.speech.create(this.buildParams(text, options));
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async *streamSynthesize(text: string, options?: TTSOptions): AsyncGenerator<Buffer> {
    this.validateText(text);
    const response = await this.client.audio.speech.create(this.buildParams(text, options));

    const body: unknown = response.body;
    if (!body) {
      throw new Error('OpenAI TTS returned empty response body');
    }

    if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          yield Buffer.from(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } else {
      const arrayBuffer = await response.arrayBuffer();
      yield Buffer.from(arrayBuffer);
    }
  }

  private buildParams(text: string, options?: TTSOptions): SpeechCreateParams {
    return {
      model: this.model,
      voice: options?.voice ?? this.voice,
      input: text,
      ...(options?.speed !== undefined && { speed: options.speed }),
      ...(options?.format && {
        response_format: mapFormat(options.format) as SpeechCreateParams['response_format'],
      }),
      ...(options?.instructions && { instructions: options.instructions }),
    };
  }

  private validateText(text: string): void {
    if (!text || text.trim().length === 0) {
      throw new Error('OpenAI TTS: text must not be empty');
    }
  }
}
