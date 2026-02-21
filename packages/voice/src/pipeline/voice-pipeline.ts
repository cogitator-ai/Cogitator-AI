import type { VoicePipelineConfig } from '../types.js';
import { PipelineSession } from './pipeline-session.js';

export class VoicePipeline {
  private readonly config: VoicePipelineConfig;

  constructor(config: VoicePipelineConfig) {
    this.config = config;
  }

  async process(audio: Buffer): Promise<{ transcript: string; response: string; audio: Buffer }> {
    const { text: transcript } = await this.config.stt.transcribe(audio);
    const { content: response } = await this.config.agent.run(transcript);
    const outputAudio = await this.config.tts.synthesize(response);
    return { transcript, response, audio: outputAudio };
  }

  createSession(): PipelineSession {
    return new PipelineSession(this.config);
  }
}
