import type { TTSProvider, TTSOptions, VoiceAudioFormat } from '../types.js';

export interface ElevenLabsTTSConfig {
  apiKey: string;
  voiceId?: string;
  model?: string;
}

const BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const DEFAULT_MODEL = 'eleven_flash_v2_5';

function mapFormat(format?: VoiceAudioFormat): string {
  switch (format) {
    case 'pcm16':
      return 'pcm_16000';
    case 'opus':
      return 'opus_48000_32';
    case 'flac':
      return 'flac_22050';
    case 'wav':
      return 'pcm_44100';
    case 'aac':
      return 'mp3_44100_128';
    case 'mp3':
    default:
      return 'mp3_44100_128';
  }
}

export class ElevenLabsTTS implements TTSProvider {
  readonly name = 'elevenlabs';

  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly model: string;

  constructor(config: ElevenLabsTTSConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<Buffer> {
    const response = await this.request(text, options);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async *streamSynthesize(text: string, options?: TTSOptions): AsyncGenerator<Buffer> {
    const response = await this.request(text, options, '/stream');

    if (!response.body) {
      throw new Error('ElevenLabs returned empty response body');
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield Buffer.from(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request(text: string, options?: TTSOptions, suffix = ''): Promise<Response> {
    const voiceId = encodeURIComponent(options?.voice ?? this.voiceId);
    const outputFormat = mapFormat(options?.format);
    const url = `${BASE_URL}/v1/text-to-speech/${voiceId}${suffix}?output_format=${outputFormat}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: this.model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ElevenLabs API error ${response.status}: ${body}`);
    }

    return response;
  }
}
