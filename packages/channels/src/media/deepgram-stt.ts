import type { SttProvider } from './media-processor';

export interface DeepgramSttConfig {
  apiKey: string;
  model?: string;
  language?: string;
}

export class DeepgramSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string | undefined;

  constructor(config: DeepgramSttConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'nova-3';
    this.language = config.language;
  }

  async transcribe(buffer: Buffer, _mimeType: string): Promise<string> {
    const params = new URLSearchParams({ model: this.model });
    if (this.language) params.set('language', this.language);

    const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/ogg',
      },
      body: new Uint8Array(buffer),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Deepgram STT failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      results: { channels: Array<{ alternatives: Array<{ transcript: string }> }> };
    };

    return data.results.channels[0]?.alternatives[0]?.transcript?.trim() ?? '';
  }
}
