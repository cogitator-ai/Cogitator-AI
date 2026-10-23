import { createRequire } from 'node:module';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

export const VERSION: string = packageJson.version;

export type {
  STTOptions,
  STTStreamOptions,
  STTProvider,
  STTStream,
  TTSOptions,
  TTSProvider,
  VADEvent,
  VADProvider,
  VADFactory,
  VoicePipelineConfig,
  VoiceAgentRunner,
  VoiceRunContext,
  VoiceTurn,
  VoiceTurnOutcome,
  RealtimeSessionConfig,
  RealtimeTool,
  RealtimeToolContext,
  WebSocketTransportConfig,
  VerifyClientResult,
  VoiceAgentConfig,
  TranscribeResult,
  VoiceAudioFormat,
  RawAudioEncoding,
  RawAudioFormat,
  RealtimeAudioFormat,
  VoicePlayback,
} from './types.js';

export {
  float32ToPcm16,
  pcm16ToFloat32,
  pcmToWav,
  wavToPcm,
  resample,
  calculateRMS,
  detectAudioFormat,
  audioMimeType,
  type DetectedAudioFormat,
} from './audio.js';

export {
  MULAW_SILENCE,
  linearToMulaw,
  mulawToLinear,
  float32ToMulaw,
  mulawToFloat32,
  pcm16ToMulaw,
  mulawToPcm16,
} from './codec.js';
export { Resampler, resampleBandLimited, type ResamplerOptions } from './resampler.js';
export { AudioTranscoder } from './transcoder.js';

export { OpenAISTT, type OpenAISTTConfig } from './stt/index.js';
export { DeepgramSTT, type DeepgramSTTConfig } from './stt/index.js';

export { OpenAITTS, type OpenAITTSConfig } from './tts/index.js';
export { ElevenLabsTTS, type ElevenLabsTTSConfig } from './tts/index.js';

export { EnergyVAD, type EnergyVADConfig } from './vad/index.js';
export { SileroVAD, type SileroVADConfig } from './vad/index.js';

export {
  VoicePipeline,
  PipelineSession,
  SentenceSplitter,
  type VoicePipelineResult,
  type PipelineSessionOptions,
  type SentenceSplitterOptions,
} from './pipeline/index.js';

export { OpenAIRealtimeAdapter } from './realtime/index.js';
export { GeminiRealtimeAdapter } from './realtime/index.js';
export { RealtimeSession } from './realtime/index.js';
export { createRealtimeTools } from './realtime/index.js';
export type { RealtimeToolsOptions, RealtimeApprovalHandler } from './realtime/index.js';

export {
  WebSocketTransport,
  VoiceClient,
  type WebSocketTransportOptions,
} from './transport/index.js';

export {
  VoiceAgent,
  type TwilioCall,
  type TwilioStreamOptions,
  type TwilioTransportConfig,
} from './voice-agent.js';

export * from './telephony/index.js';
export {
  createCogitatorRunner,
  type CogitatorLike,
  type CogitatorRunnerAgent,
  type CogitatorRunnerOptions,
  type CogitatorRunnerRunOptions,
} from './cogitator-runner.js';

export { transcribeTool, speakTool, voiceTools, type VoiceTool } from './tools.js';
