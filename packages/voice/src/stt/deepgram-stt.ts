import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { audioMimeType, detectAudioFormat } from '../audio.js';
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
  /** Sample rate of raw PCM16 audio (streams and headerless batch input). Defaults to 16000. */
  sampleRate?: number;
}

const DEFAULT_MODEL = 'nova-3';
const DEFAULT_SAMPLE_RATE = 16000;
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
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: DeepgramAlternative[] };
}

function mapWords(words: DeepgramWord[] | undefined): TranscribeResult['words'] {
  if (!words || words.length === 0) return undefined;
  return words.map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
  }));
}

export class DeepgramSTT implements STTProvider {
  readonly name = 'deepgram';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly language?: string;
  private readonly sampleRate: number;

  constructor(config: DeepgramSTTConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    this.language = config.language;
    this.sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  async transcribe(audio: Buffer, options?: STTOptions): Promise<TranscribeResult> {
    const params = new URLSearchParams({
      model: this.model,
      punctuate: 'true',
    });

    const lang = options?.language ?? this.language;
    if (lang) params.set('language', lang);

    const format = detectAudioFormat(audio);
    let contentType: string;
    if (format) {
      contentType = audioMimeType(format);
    } else {
      contentType = 'application/octet-stream';
      params.set('encoding', 'linear16');
      params.set('sample_rate', String(this.sampleRate));
      params.set('channels', '1');
    }

    const response = await fetch(`${BASE_URL}?${params}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Deepgram API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as DeepgramBatchResponse;
    return this.mapBatchResponse(data);
  }

  createStream(options?: STTStreamOptions): STTStream {
    return new DeepgramSTTStream(this.apiKey, this.model, this.language, {
      ...options,
      sampleRate: options?.sampleRate ?? this.sampleRate,
    });
  }

  private mapBatchResponse(data: DeepgramBatchResponse): TranscribeResult {
    const alt = data.results?.channels?.[0]?.alternatives?.[0];

    const result: TranscribeResult = {
      text: alt?.transcript ?? '',
    };

    if (data.metadata?.duration !== undefined) {
      result.duration = data.metadata.duration;
    }

    const words = mapWords(alt?.words);
    if (words) result.words = words;

    return result;
  }
}

const CLOSE_TIMEOUT_MS = 10_000;

class DeepgramSTTStream extends EventEmitter implements STTStream {
  private ws: WebSocket;
  private ready = false;
  private closed = false;
  private remoteClosed = false;
  private closePromise: Promise<TranscribeResult> | null = null;
  private pendingChunks: Buffer[] = [];
  private segments: string[] = [];
  private words: NonNullable<TranscribeResult['words']> = [];
  private audioEnd = 0;

  constructor(
    apiKey: string,
    model: string,
    language: string | undefined,
    options: STTStreamOptions & { sampleRate: number }
  ) {
    super();

    const params = new URLSearchParams({
      model,
      punctuate: 'true',
      interim_results: String(options.interimResults ?? true),
      encoding: 'linear16',
      sample_rate: String(options.sampleRate),
      channels: '1',
    });

    const lang = options.language ?? language;
    if (lang) params.set('language', lang);
    if (options.endpointing !== undefined) {
      params.set('endpointing', String(options.endpointing));
    }

    this.ws = new WebSocket(`${WS_URL}?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    this.ws.on('open', () => {
      this.ready = true;
      for (const chunk of this.pendingChunks) {
        this.ws.send(chunk);
      }
      this.pendingChunks = [];
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      let msg: DeepgramStreamMessage;
      try {
        msg = JSON.parse(String(raw)) as DeepgramStreamMessage;
      } catch {
        return;
      }
      if (msg.type !== undefined && msg.type !== 'Results') return;

      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;

      if (msg.is_final) {
        if (typeof msg.start === 'number' && typeof msg.duration === 'number') {
          this.audioEnd = Math.max(this.audioEnd, msg.start + msg.duration);
        }
        if (!alt.transcript) return;
        this.segments.push(alt.transcript);
        const words = mapWords(alt.words);
        if (words) this.words.push(...words);

        const segment: TranscribeResult = { text: alt.transcript };
        if (words) segment.words = words;
        if (typeof msg.duration === 'number') segment.duration = msg.duration;
        this.emit('final', segment);
      } else if (alt.transcript) {
        this.emit('partial', alt.transcript);
      }
    });

    this.ws.on('error', (err: Error) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.ready = false;
      if (!this.closed) {
        this.remoteClosed = true;
        const dropped = this.pendingChunks.length;
        this.pendingChunks = [];
        if (this.listenerCount('error') > 0) {
          const detail = reason.toString() || 'no reason';
          this.emit(
            'error',
            new Error(
              `DeepgramSTTStream: connection closed unexpectedly (code ${code}: ${detail})` +
                (dropped > 0 ? `, ${dropped} chunk(s) dropped` : '')
            )
          );
        }
      }
    });
  }

  write(chunk: Buffer): void {
    if (this.closed) {
      throw new Error('DeepgramSTTStream: cannot write after close');
    }
    if (this.remoteClosed) return;
    if (this.ready) {
      this.ws.send(chunk);
    } else {
      this.pendingChunks.push(chunk);
    }
  }

  async close(): Promise<TranscribeResult> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;

    this.closePromise = new Promise<TranscribeResult>((resolve) => {
      const state = this.ws.readyState;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
        resolve(this.buildResult());
        return;
      }

      const timeout = setTimeout(() => {
        this.ws.terminate();
        resolve(this.buildResult());
      }, CLOSE_TIMEOUT_MS);

      this.ws.once('close', () => {
        clearTimeout(timeout);
        resolve(this.buildResult());
      });

      if (state === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        return;
      }

      if (this.pendingChunks.length === 0) {
        clearTimeout(timeout);
        this.ws.removeAllListeners('close');
        this.ws.on('error', () => {});
        this.ws.terminate();
        resolve(this.buildResult());
        return;
      }

      this.ws.once('open', () => {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      });
    });

    return this.closePromise;
  }

  private buildResult(): TranscribeResult {
    const result: TranscribeResult = { text: this.segments.join(' ').trim() };
    if (this.audioEnd > 0) result.duration = this.audioEnd;
    if (this.words.length > 0) result.words = [...this.words];
    return result;
  }
}
