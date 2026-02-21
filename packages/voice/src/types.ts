import type { TranscribeResult, VoiceAudioFormat } from '@cogitator-ai/types';

export type { TranscribeResult, VoiceAudioFormat };

export interface STTOptions {
  language?: string;
  prompt?: string;
}

export interface STTStreamOptions extends STTOptions {
  interimResults?: boolean;
  endpointing?: number;
}

export interface STTProvider {
  readonly name: string;
  transcribe(audio: Buffer, options?: STTOptions): Promise<TranscribeResult>;
  createStream(options?: STTStreamOptions): STTStream;
}

export interface STTStream {
  write(chunk: Buffer): void;
  close(): Promise<TranscribeResult>;
  on(event: 'partial', cb: (text: string) => void): this;
  on(event: 'final', cb: (result: TranscribeResult) => void): this;
  on(event: 'error', cb: (error: Error) => void): this;
  off(event: string, cb: (...args: unknown[]) => void): this;
  removeAllListeners(): this;
}

export interface TTSOptions {
  voice?: string;
  speed?: number;
  format?: VoiceAudioFormat;
  instructions?: string;
}

export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, options?: TTSOptions): Promise<Buffer>;
  streamSynthesize(text: string, options?: TTSOptions): AsyncGenerator<Buffer>;
}

export type VADEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end'; duration: number }
  | { type: 'speech'; probability: number }
  | { type: 'silence' };

export interface VADProvider {
  readonly name: string;
  process(samples: Float32Array): VADEvent;
  reset(): void;
}

export interface VoicePipelineConfig {
  stt: STTProvider;
  tts: TTSProvider;
  vad?: VADProvider;
  agent: { run: (input: string) => Promise<{ content: string }> };
  sampleRate?: number;
}

export interface RealtimeSessionConfig {
  provider: 'openai' | 'gemini';
  model?: string;
  apiKey: string;
  instructions?: string;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: unknown) => Promise<unknown>;
  }>;
  voice?: string;
}

export interface WebSocketTransportConfig {
  path?: string;
  maxConnections?: number;
}

export interface VoiceAgentConfig {
  agent: { run: (input: string) => Promise<{ content: string }> };
  mode: 'pipeline' | 'realtime';
  stt?: STTProvider;
  tts?: TTSProvider;
  vad?: VADProvider;
  realtimeProvider?: 'openai' | 'gemini';
  realtimeApiKey?: string;
  realtimeModel?: string;
  voice?: string;
  transport?: WebSocketTransportConfig;
}
