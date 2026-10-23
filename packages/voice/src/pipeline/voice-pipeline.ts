import type { VADFactory, VADProvider, VoicePipelineConfig } from '../types.js';
import { PipelineSession, type PipelineSessionOptions } from './pipeline-session.js';

export interface VoicePipelineResult {
  transcript: string;
  response: string;
  audio: Buffer;
}

export class VoicePipeline {
  private readonly config: VoicePipelineConfig;
  private sharedVADSessions = 0;

  constructor(config: VoicePipelineConfig) {
    this.config = config;
  }

  /**
   * One-shot STT -> Agent -> TTS. Silent input (empty transcript) skips the agent and TTS
   * and returns empty strings with an empty audio buffer. It returns the answer's audio as one
   * buffer, so it runs the agent with `run` and synthesizes the whole answer at once, also for a
   * runner that streams: use a session (`createSession`) to speak while the answer is generated.
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

  /**
   * A session with a VAD of its own: from the `vad` factory, or a `clone()` of the `vad`
   * instance, disposed (`dispose()`) when the session closes. An instance without `clone` is
   * shared by every session, with a warning from the second session on, and never disposed.
   */
  createSession(options?: PipelineSessionOptions): PipelineSession {
    return new PipelineSession({ ...this.config, vad: this.sessionVAD() }, options);
  }

  /** The session's VAD: a factory when the session owns what it makes, else the shared one */
  private sessionVAD(): VADProvider | VADFactory | undefined {
    const vad = this.config.vad;
    if (vad === undefined || typeof vad === 'function') return vad;
    if (vad.clone) {
      const copy = vad.clone();
      return () => copy;
    }
    if (++this.sharedVADSessions === 2) {
      process.emitWarning(
        `VAD "${vad.name}" has no clone(), so every session of the pipeline shares its state. ` +
          'Pass a factory (vad: () => new MyVAD()) to give each session its own.',
        { code: 'COGITATOR_SHARED_VAD' }
      );
    }
    return vad;
  }
}
