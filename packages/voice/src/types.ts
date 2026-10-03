import type { IncomingMessage } from 'node:http';
import type { TranscribeResult, VoiceAudioFormat } from '@cogitator-ai/types';

export type { TranscribeResult, VoiceAudioFormat };

export interface STTOptions {
  language?: string;
  prompt?: string;
}

export interface STTStreamOptions extends STTOptions {
  interimResults?: boolean;
  endpointing?: number;
  /** Sample rate of the raw PCM16 audio written to the stream. Defaults to 16000. */
  sampleRate?: number;
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
  process(samples: Float32Array): VADEvent | Promise<VADEvent>;
  reset(): void;
}

export interface VoiceRunContext {
  /** Identifier of the voice session (one per connected client / pipeline session). */
  sessionId: string;
  /** Aborted when the turn is interrupted or the session closes. */
  signal?: AbortSignal;
}

export interface VoiceAgentRunner {
  run(input: string, context?: VoiceRunContext): Promise<{ content: string }>;
  /** Used as realtime-mode instructions when `VoiceAgentConfig.instructions` is not set. */
  readonly instructions?: string;
}

export interface VoicePipelineConfig {
  stt: STTProvider;
  tts: TTSProvider;
  vad?: VADProvider;
  agent: VoiceAgentRunner;
  /** @deprecated Not used by the pipeline. Audio is processed at provider-native rates. */
  sampleRate?: number;
}

export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
}

export interface RealtimeSessionConfig {
  provider: 'openai' | 'gemini';
  model?: string;
  apiKey: string;
  instructions?: string;
  tools?: RealtimeTool[];
  voice?: string;
}

/** `true` accepts, `false` rejects with 401, `{ code, message }` rejects with that status. */
export type VerifyClientResult = boolean | { code: number; message: string };

export interface WebSocketTransportConfig {
  path?: string;
  maxConnections?: number;
  /**
   * Authorize an incoming upgrade request. Return `true` to accept, `false`
   * to reject with 401, or `{ code, message }` to reject with that status.
   */
  verifyClient?: (req: IncomingMessage) => VerifyClientResult | Promise<VerifyClientResult>;
}

export interface VoiceAgentConfig {
  agent: VoiceAgentRunner;
  mode: 'pipeline' | 'realtime';
  stt?: STTProvider;
  tts?: TTSProvider;
  vad?: VADProvider;
  realtimeProvider?: 'openai' | 'gemini';
  realtimeApiKey?: string;
  realtimeModel?: string;
  /** Realtime-mode system instructions. Falls back to `agent.instructions`. */
  instructions?: string;
  /** Realtime-mode tools executed by the session on behalf of the model. */
  tools?: RealtimeTool[];
  voice?: string;
  transport?: WebSocketTransportConfig;
}
