import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type {
  STTProvider,
  STTOptions,
  STTStreamOptions,
  STTStream,
  TranscribeResult,
} from '../types.js';

export interface DeepgramSTTConfig {
  apiKey: string;
  model?: string;
  language?: string;
}

const DEFAULT_MODEL = 'nova-3';
const BASE_URL = 'https://api.deepgram.com/v1/listen';
const WS_URL = 'wss://api.deepgram.com/v1/listen';

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words?: DeepgramWord[];
}

interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}

interface DeepgramBatchResponse {
  results: { channels: DeepgramChannel[] };
  metadata?: { duration?: number };
}

interface DeepgramStreamMessage {
  is_final: boolean;
  channel: { alternatives: DeepgramAlternative[] };
  metadata?: { duration?: number };
}

export class DeepgramSTT implements STTProvider {
  readonly name = 'deepgram';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly language?: string;

  constructor(config: DeepgramSTTConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.language = config.language;
  }

  async transcribe(audio: Buffer, options?: STTOptions): Promise<TranscribeResult> {
    const params = new URLSearchParams({
      model: this.model,
      punctuate: 'true',
    });

    const lang = options?.language ?? this.language;
    if (lang) params.set('language', lang);

    const response = await fetch(`${BASE_URL}?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: new Uint8Array(audio),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as DeepgramBatchResponse;
    return this.mapBatchResponse(data);
  }

  createStream(options?: STTStreamOptions): STTStream {
    return new DeepgramSTTStream(this.apiKey, this.model, this.language, options);
  }

  private mapBatchResponse(data: DeepgramBatchResponse): TranscribeResult {
    const alt = data.results.channels[0]?.alternatives[0];

    const result: TranscribeResult = {
      text: alt?.transcript ?? '',
    };

    if (data.metadata?.duration !== undefined) {
      result.duration = data.metadata.duration;
    }

    if (alt?.words && alt.words.length > 0) {
      result.words = alt.words.map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
      }));
    }

    return result;
  }
}

class DeepgramSTTStream extends EventEmitter implements STTStream {
  private ws: WebSocket;
  private ready = false;
  private pendingChunks: Buffer[] = [];
  private lastResult: TranscribeResult = { text: '' };

  constructor(
    apiKey: string,
    model: string,
    language: string | undefined,
    options?: STTStreamOptions
  ) {
    super();

    const params = new URLSearchParams({
      model,
      punctuate: 'true',
      interim_results: 'true',
    });

    const lang = options?.language ?? language;
    if (lang) params.set('language', lang);
    if (options?.endpointing !== undefined) {
      params.set('endpointing', String(options.endpointing));
    }

    this.ws = new WebSocket(`${WS_URL}?${params}`, [`token:${apiKey}`]);

    this.ws.on('open', () => {
      this.ready = true;
      for (const chunk of this.pendingChunks) {
        this.ws.send(chunk);
      }
      this.pendingChunks = [];
    });

    this.ws.on('message', (raw: Buffer | string) => {
      let msg: DeepgramStreamMessage;
      try {
        msg = JSON.parse(String(raw)) as DeepgramStreamMessage;
      } catch {
        return;
      }
      const alt = msg.channel?.alternatives[0];
      if (!alt?.transcript) return;

      if (msg.is_final) {
        const result = this.mapStreamResult(msg);
        this.lastResult = result;
        this.emit('final', result);
      } else {
        this.emit('partial', alt.transcript);
      }
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      this.ready = false;
    });
  }

  write(chunk: Buffer): void {
    if (this.ready) {
      this.ws.send(chunk);
    } else {
      this.pendingChunks.push(chunk);
    }
  }

  async close(): Promise<TranscribeResult> {
    if (!this.ready) {
      this.ws.close();
      return this.lastResult;
    }

    return new Promise<TranscribeResult>((resolve) => {
      this.ws.on('close', () => resolve(this.lastResult));
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    });
  }

  private mapStreamResult(msg: DeepgramStreamMessage): TranscribeResult {
    const alt = msg.channel.alternatives[0];
    if (!alt) return { text: '' };
    const result: TranscribeResult = {
      text: alt.transcript,
    };

    if (msg.metadata?.duration !== undefined) {
      result.duration = msg.metadata.duration;
    }

    if (alt.words && alt.words.length > 0) {
      result.words = alt.words.map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
      }));
    }

    return result;
  }
}
