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
  VoicePipelineConfig,
  VoiceAgentRunner,
  VoiceRunContext,
  RealtimeSessionConfig,
  RealtimeTool,
  WebSocketTransportConfig,
  VerifyClientResult,
  VoiceAgentConfig,
  TranscribeResult,
  VoiceAudioFormat,
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

export { OpenAISTT, type OpenAISTTConfig } from './stt/index.js';
export { DeepgramSTT, type DeepgramSTTConfig } from './stt/index.js';

export { OpenAITTS, type OpenAITTSConfig } from './tts/index.js';
export { ElevenLabsTTS, type ElevenLabsTTSConfig } from './tts/index.js';

export { EnergyVAD, type EnergyVADConfig } from './vad/index.js';
export { SileroVAD, type SileroVADConfig } from './vad/index.js';

export {
  VoicePipeline,
  PipelineSession,
  type VoicePipelineResult,
  type PipelineSessionOptions,
} from './pipeline/index.js';

export { OpenAIRealtimeAdapter } from './realtime/index.js';
export { GeminiRealtimeAdapter } from './realtime/index.js';
export { RealtimeSession } from './realtime/index.js';

export {
  WebSocketTransport,
  VoiceClient,
  type WebSocketTransportOptions,
} from './transport/index.js';

export { VoiceAgent } from './voice-agent.js';
export {
  createCogitatorRunner,
  type CogitatorLike,
  type CogitatorRunnerOptions,
} from './cogitator-runner.js';

export { transcribeTool, speakTool, voiceTools, type VoiceTool } from './tools.js';
