import type { VoicePipelineConfig } from '../types.js';
import { PipelineSession, type PipelineSessionOptions } from './pipeline-session.js';

export interface VoicePipelineResult {
  transcript: string;
  response: string;
  audio: Buffer;
}

export class VoicePipeline {
  private readonly config: VoicePipelineConfig;

  constructor(config: VoicePipelineConfig) {
    this.config = config;
  }

  /**
   * One-shot STT -> Agent -> TTS. Silent input (empty transcript) skips the agent and TTS
   * and returns empty strings with an empty audio buffer.
   */
  async process(audio: Buffer, options: PipelineSessionOptions = {}): Promise<VoicePipelineResult> {
    const { text: transcript } = await this.config.stt.transcribe(audio);
    if (transcript.trim().length === 0) {
      return { transcript, response: '', audio: Buffer.alloc(0) };
    }

    const { content: response } = await this.config.agent.run(
      transcript,
      options.sessionId ? { sessionId: options.sessionId } : undefined
    );
    if (response.trim().length === 0) {
      return { transcript, response, audio: Buffer.alloc(0) };
    }

    const outputAudio = await this.config.tts.synthesize(response, this.config.ttsOptions);
    return { transcript, response, audio: outputAudio };
  }

  createSession(options?: PipelineSessionOptions): PipelineSession {
    return new PipelineSession(this.config, options);
  }
}
