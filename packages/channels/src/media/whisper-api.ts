import type { SttProvider } from './media-processor';

export interface GroqSttConfig {
  apiKey: string;
  model?: string;
}

export class GroqSttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: GroqSttConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'whisper-large-v3';
  }

  async transcribe(buffer: Buffer, mimeType: string): Promise<string> {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'ogg';
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', this.model);

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq STT failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text.trim();
  }
}

export interface OpenAISttConfig {
  apiKey: string;
  model?: string;
}

export class OpenAISttProvider implements SttProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: OpenAISttConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'whisper-1';
  }

  async transcribe(buffer: Buffer, mimeType: string): Promise<string> {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'ogg';
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', this.model);

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI STT failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text.trim();
  }
}
