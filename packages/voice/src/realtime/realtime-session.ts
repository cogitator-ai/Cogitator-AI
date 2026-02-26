import { EventEmitter } from 'node:events';
import type { RealtimeSessionConfig } from '../types.js';
import { OpenAIRealtimeAdapter } from './openai-realtime.js';
import { GeminiRealtimeAdapter } from './gemini-realtime.js';

type RealtimeAdapter = OpenAIRealtimeAdapter | GeminiRealtimeAdapter;

const FORWARDED_EVENTS = [
  'connected',
  'speech_start',
  'transcript',
  'audio',
  'tool_call',
  'error',
] as const;

interface RealtimeSessionEvents {
  connected: [];
  audio: [chunk: Buffer];
  transcript: [text: string, role: 'user' | 'assistant'];
  tool_call: [name: string, args: unknown];
  speech_start: [];
  error: [error: Error];
}

export class RealtimeSession extends EventEmitter<RealtimeSessionEvents> {
  private readonly adapter: RealtimeAdapter;
  private readonly _provider: RealtimeSessionConfig['provider'];

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
      this.adapter.on(event, (...args: unknown[]) => {
        this.emit(event, ...(args as never));
      });
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
    this.adapter.close();
  }
}
