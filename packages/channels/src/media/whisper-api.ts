import type { SttProvider } from './media-processor';
import { audioExtension, baseMimeType } from './audio-format';

async function transcribeOpenAICompatible(
  endpoint: string,
  apiKey: string,
  model: string,
  buffer: Buffer,
  mimeType: string,
  provider: string
): Promise<string> {
  const blob = new Blob([new Uint8Array(buffer)], { type: baseMimeType(mimeType) });

  const form = new FormData();
  form.append('file', blob, `audio.${audioExtension(mimeType)}`);
  form.append('model', model);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${provider} STT failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { text?: unknown };
  return typeof data.text === 'string' ? data.text.trim() : '';
}

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
    return transcribeOpenAICompatible(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      this.apiKey,
      this.model,
      buffer,
      mimeType,
      'Groq'
    );
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
    return transcribeOpenAICompatible(
      'https://api.openai.com/v1/audio/transcriptions',
      this.apiKey,
      this.model,
      buffer,
      mimeType,
      'OpenAI'
    );
  }
}
