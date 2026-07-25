import { EventEmitter } from 'node:events';
import type { RealtimeSessionConfig } from '../types.js';
import { OpenAIRealtimeAdapter } from './openai-realtime.js';
import { GeminiRealtimeAdapter } from './gemini-realtime.js';

type RealtimeAdapter = OpenAIRealtimeAdapter | GeminiRealtimeAdapter;

const FORWARDED_EVENTS = [
  'connected',
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
      const forwarder = (...args: unknown[]) => {
        this.emit(event, ...(args as never));
      };
      this.forwarders.set(event, forwarder);
      this.adapter.on(event, forwarder);
    }
  }

  get provider(): RealtimeSessionConfig['provider'] {
    return this._provider;
  }

  async connect(): Promise<void> {
    return this.adapter.connect();
  }

  pushAudio(chunk: Buffer): void {
    this.adapter.pushAudio(chunk);
  }

  sendText(text: string): void {
    this.adapter.sendText(text);
  }

  interrupt(): void {
    this.adapter.interrupt();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    for (const [event, forwarder] of this.forwarders) {
      this.adapter.off(event, forwarder);
    }
    this.forwarders.clear();
    this.adapter.close();
  }
}
