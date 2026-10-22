import type { IncomingMessage } from 'node:http';
import type {
  ToolInvocationOptions,
  TranscribeResult,
  VoiceAudioFormat,
} from '@cogitator-ai/types';

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

/** How a streamed voice turn ended, as `VoiceTurn.settle` hears it. */
export interface VoiceTurnOutcome {
  /**
   * The text whose audio was sent to the client in full, a prefix of the text the turn yielded.
   * The server cannot know how much of that audio the client played before it stopped.
   */
  spoken: string;
  /**
   * True when the turn stopped before all of its answer was spoken: an interruption, a barge-in,
   * the session closing, or a failure of the model or of speech synthesis
   */
  interrupted: boolean;
}

/**
 * A turn a streaming runner answers: the text of the answer as it is generated, and an optional
 * `settle` the session calls once the turn is over, with what was spoken.
 */
export interface VoiceTurn extends AsyncIterable<string> {
  /**
   * Called once after the turn, whether it completed, was interrupted or failed, before the
   * session starts the next streamed turn. A runner that keeps a conversation records there what
   * the user actually heard.
   */
  settle?(outcome: VoiceTurnOutcome): Promise<void>;
}

export interface VoiceAgentRunner {
  run(input: string, context?: VoiceRunContext): Promise<{ content: string }>;
  /**
   * Answers a turn as a stream of text deltas. When present, `PipelineSession` uses it instead of
   * `run`: it speaks the answer sentence by sentence while it is generated, and settles the turn
   * with what was spoken. The turn must stop when `context.signal` aborts.
   */
  stream?(input: string, context: VoiceRunContext): VoiceTurn;
  /**
   * The agent's own tools as realtime tools, for a `VoiceAgent` in realtime mode without
   * `tools` (see `VoiceAgentConfig.agentTools`). `createCogitatorRunner` builds them with
   * `createRealtimeTools`.
   */
  realtimeTools?(options?: RealtimeToolsOptions): RealtimeTool[];
  /** Used as realtime-mode instructions when `VoiceAgentConfig.instructions` is not set. */
  readonly instructions?: string;
}

export interface VoicePipelineConfig {
  stt: STTProvider;
  tts: TTSProvider;
  vad?: VADProvider;
  agent: VoiceAgentRunner;
  /**
   * Options passed to every `tts.synthesize` / `tts.streamSynthesize` call, e.g.
   * `{ format: 'pcm16' }` for raw audio or a per-pipeline `voice`, `speed` or `instructions`.
   */
  ttsOptions?: TTSOptions;
  /**
   * Stop the reply and start listening when the VAD hears speech while the agent is thinking or
   * speaking. Off by default: without echo cancellation on the client, the agent's own voice
   * coming back through the microphone would interrupt it. Needs a `vad`.
   */
  bargeIn?: boolean;
  /**
   * Longest piece of a streamed answer sent to TTS at once, in characters (default 250). A
   * sentence without a break before it is cut at the last whitespace.
   */
  maxSentenceLength?: number;
  /** @deprecated Not used by the pipeline. Audio is processed at provider-native rates. */
  sampleRate?: number;
}

/** What a realtime tool call gets besides its arguments. */
export interface RealtimeToolContext {
  /** The provider's id of the call */
  callId: string;
  /**
   * Aborted when the session closes or loses its connection, or when the provider cancels the
   * call (Gemini cancels pending calls when the user interrupts)
   */
  signal: AbortSignal;
  /** The session's `sessionId`: the client's id in a `VoiceAgent` */
  sessionId?: string;
}

/**
 * A tool a realtime session runs for the model. `createRealtimeTools()` builds them from
 * Cogitator tools, run through `cogitator.invokeTool` like in an agent run.
 */
export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Runs the tool. A result made of parts (`toolContent()` from `@cogitator-ai/core`, or an
   * object with a base64 `image`) reaches the model as the text of its parts, images and files
   * described, see `toolImages` for sending the images themselves.
   */
  execute: (args: unknown, context: RealtimeToolContext) => Promise<unknown>;
  /** Most characters of the tool's result the model reads (default 100 000) */
  maxResultLength?: number;
}

export interface RealtimeToolsOptions {
  /**
   * Decides a call that needs approval (`requiresApproval`, or the guardrails), as
   * `RunOptions.onApproval` does in a run. Without it `guardrails.onToolApproval` decides, and a
   * call nobody approves does not run: the model gets an error saying it needs approval
   */
  onApproval?: ToolInvocationOptions['onApproval'];
  /** Agent id the tools see in their context (default `'voice'`) */
  agentId?: string;
  /**
   * Thread id the tools see in their context. Defaults to `voice:<sessionId>`, the thread
   * `createCogitatorRunner` gives the session's agent runs
   */
  threadId?: (context: RealtimeToolContext) => string | undefined;
  /** The user the calls act for */
  userId?: string;
}

export interface RealtimeSessionConfig {
  provider: 'openai' | 'gemini';
  model?: string;
  apiKey: string;
  instructions?: string;
  tools?: RealtimeTool[];
  /** Id of the session, handed to tools in `RealtimeToolContext.sessionId` */
  sessionId?: string;
  /**
   * Send the images that tools return to the model, for a model that takes images: with OpenAI
   * as a user message with `input_image` parts after the tool outputs (`gpt-realtime`,
   * `gpt-realtime-2`), with Gemini as `parts` of the function response (Gemini 3 models).
   * Default false: the model reads a description of each image.
   */
  toolImages?: boolean;
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
  /** Pipeline-mode options passed to every TTS call (see `VoicePipelineConfig.ttsOptions`). */
  ttsOptions?: TTSOptions;
  /** Pipeline mode: interrupt the reply when the user starts speaking (see `VoicePipelineConfig.bargeIn`). */
  bargeIn?: boolean;
  /** Pipeline mode: see `VoicePipelineConfig.maxSentenceLength`. */
  maxSentenceLength?: number;
  realtimeProvider?: 'openai' | 'gemini';
  realtimeApiKey?: string;
  realtimeModel?: string;
  /** Realtime-mode system instructions. Falls back to `agent.instructions`. */
  instructions?: string;
  /**
   * Realtime-mode tools executed by the session on behalf of the model. They replace the agent's
   * own tools (see `agentTools`), and `[]` gives the model none. Build them with
   * `createRealtimeTools(cogitator, tools)` so calls get approval, guardrails, the sandbox and
   * timeouts like in an agent run.
   */
  tools?: RealtimeTool[];
  /**
   * Realtime mode without `tools`: give the model the agent's own tools, from
   * `agent.realtimeTools()` (a `createCogitatorRunner` runner builds them with
   * `createRealtimeTools`, so calls go through approvals, guardrails and the sandbox). Default
   * true. Pass options, such as `onApproval`, to configure them, or `false` to turn it off.
   */
  agentTools?: boolean | RealtimeToolsOptions;
  /** Realtime mode: send the images tools return to the model (see `RealtimeSessionConfig.toolImages`). */
  toolImages?: boolean;
  voice?: string;
  transport?: WebSocketTransportConfig;
}
