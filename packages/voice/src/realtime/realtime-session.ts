import { EventEmitter } from 'node:events';
import type { RealtimeSessionConfig } from '../types.js';
import { OpenAIRealtimeAdapter } from './openai-realtime.js';
import { GeminiRealtimeAdapter } from './gemini-realtime.js';

type RealtimeAdapter = OpenAIRealtimeAdapter | GeminiRealtimeAdapter;

const MAX_PENDING_AUDIO_BYTES = 1024 * 1024;

type PendingInput = { kind: 'audio'; chunk: Buffer } | { kind: 'text'; text: string };

const FORWARDED_EVENTS = [
  'disconnected',
  'speech_start',
  'transcript',
  'audio',
  'tool_call',
  'turn_end',
  'error',
] as const;

interface RealtimeSessionEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  audio: [chunk: Buffer];
  transcript: [text: string, role: 'user' | 'assistant'];
  tool_call: [name: string, args: unknown];
  speech_start: [];
  turn_end: [];
  error: [error: Error];
}

export class RealtimeSession extends EventEmitter<RealtimeSessionEvents> {
  private readonly adapter: RealtimeAdapter;
  private readonly _provider: RealtimeSessionConfig['provider'];
  private readonly forwarders = new Map<string, (...args: unknown[]) => void>();
  private _closed = false;
  private pending: PendingInput[] = [];
  private pendingAudioBytes = 0;

  constructor(config: RealtimeSessionConfig) {
    super();
    this._provider = config.provider;
    switch (config.provider) {
      case 'openai':
        this.adapter = new OpenAIRealtimeAdapter(config);
        break;
      case 'gemini':
        this.adapter = new GeminiRealtimeAdapter(config);
        break;
      default:
        throw new Error(`Unknown realtime provider: ${config.provider as string}`);
    }

    for (const event of FORWARDED_EVENTS) {
      this.addForwarder(event, (...args: unknown[]) => {
        this.emit(event, ...(args as never));
      });
    }

    this.addForwarder('connected', () => {
      this.flushPending();
      this.emit('connected');
    });
  }

  get provider(): RealtimeSessionConfig['provider'] {
    return this._provider;
  }

  get isConnected(): boolean {
    return this.adapter.isConnected;
  }

  async connect(): Promise<void> {
    if (this._closed) {
      throw new Error('RealtimeSession is closed');
    }
    return this.adapter.connect();
  }

  /**
   * Send audio to the model. Audio pushed before the connection is established is
   * buffered (up to 1MB, oldest audio dropped first) and flushed once connected.
   */
  pushAudio(chunk: Buffer): void {
    if (this._closed) return;
    if (this.adapter.isConnected) {
      this.adapter.pushAudio(chunk);
      return;
    }

    this.pending.push({ kind: 'audio', chunk });
    this.pendingAudioBytes += chunk.length;
    while (this.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES) {
      const index = this.pending.findIndex((input) => input.kind === 'audio');
      if (index === -1) break;
      const [dropped] = this.pending.splice(index, 1);
      if (dropped?.kind === 'audio') this.pendingAudioBytes -= dropped.chunk.length;
    }
  }

  /** Send a user text turn. Text sent before the connection is established is queued. */
  sendText(text: string): void {
    if (this._closed) return;
    if (this.adapter.isConnected) {
      this.adapter.sendText(text);
      return;
    }
    this.pending.push({ kind: 'text', text });
  }

  interrupt(): void {
    this.adapter.interrupt();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.pending = [];
    this.pendingAudioBytes = 0;
    for (const [event, forwarder] of this.forwarders) {
      this.adapter.off(event as keyof RealtimeSessionEvents, forwarder);
    }
    this.forwarders.clear();
    this.adapter.close();
  }

  private addForwarder(
    event: keyof RealtimeSessionEvents,
    forwarder: (...args: unknown[]) => void
  ): void {
    this.forwarders.set(event, forwarder);
    this.adapter.on(event, forwarder);
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = [];
    this.pendingAudioBytes = 0;
    for (const input of pending) {
      if (input.kind === 'audio') this.adapter.pushAudio(input.chunk);
      else this.adapter.sendText(input.text);
    }
  }
}
