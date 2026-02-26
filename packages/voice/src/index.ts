export const VERSION = '0.1.7';

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
  RealtimeSessionConfig,
  WebSocketTransportConfig,
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
} from './audio.js';

export { OpenAISTT, type OpenAISTTConfig } from './stt/index.js';
export { DeepgramSTT, type DeepgramSTTConfig } from './stt/index.js';

export { OpenAITTS, type OpenAITTSConfig } from './tts/index.js';
export { ElevenLabsTTS, type ElevenLabsTTSConfig } from './tts/index.js';

export { EnergyVAD, type EnergyVADConfig } from './vad/index.js';
export { SileroVAD, type SileroVADConfig } from './vad/index.js';

export { VoicePipeline, PipelineSession } from './pipeline/index.js';

export { OpenAIRealtimeAdapter } from './realtime/index.js';
export { GeminiRealtimeAdapter } from './realtime/index.js';
export { RealtimeSession } from './realtime/index.js';

export { WebSocketTransport, VoiceClient } from './transport/index.js';

export { VoiceAgent } from './voice-agent.js';

export { transcribeTool, speakTool, voiceTools, type VoiceTool } from './tools.js';
