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
    case 'mp3':
      return 'mp3_44100_128';
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
    const voiceId = options?.voice ?? this.voiceId;
    const outputFormat = mapFormat(options?.format);
    const url = `${BASE_URL}/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;

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
      throw new Error(`ElevenLabs API error ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async *streamSynthesize(text: string, options?: TTSOptions): AsyncGenerator<Buffer> {
    const voiceId = options?.voice ?? this.voiceId;
    const outputFormat = mapFormat(options?.format);
    const url = `${BASE_URL}/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`;

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
      throw new Error(`ElevenLabs API error ${response.status}`);
    }

    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of body) {
      yield Buffer.from(chunk);
    }
  }
}
