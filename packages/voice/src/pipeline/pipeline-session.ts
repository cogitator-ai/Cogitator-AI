import { EventEmitter } from 'node:events';
import type { STTStream, VoicePipelineConfig } from '../types.js';
import { pcm16ToFloat32 } from '../audio.js';

type SessionState = 'idle' | 'listening' | 'processing' | 'speaking';

export class PipelineSession extends EventEmitter {
  private readonly stt: VoicePipelineConfig['stt'];
  private readonly tts: VoicePipelineConfig['tts'];
  private readonly vad: VoicePipelineConfig['vad'];
  private readonly agent: VoicePipelineConfig['agent'];
  private state: SessionState = 'idle';
  private stream: STTStream | null = null;
  private interrupted = false;
  private closed = false;

  constructor(config: VoicePipelineConfig) {
    super();
    this.stt = config.stt;
    this.tts = config.tts;
    this.vad = config.vad;
    this.agent = config.agent;
  }

  pushAudio(chunk: Buffer): void {
    if (this.closed) return;

    if (this.vad) {
      this.handleVAD(chunk);
    } else {
      this.handleNoVAD(chunk);
    }
  }

  interrupt(): void {
    this.interrupted = true;

    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream = null;
    }

    this.vad?.reset();
    this.state = 'idle';
  }

  async close(): Promise<void> {
    this.closed = true;
    this.interrupted = true;

    if (this.stream) {
      this.stream.removeAllListeners();
      this.stream = null;
    }

    this.removeAllListeners();
  }

  private handleVAD(chunk: Buffer): void {
    const samples = pcm16ToFloat32(chunk);
    const event = this.vad!.process(samples);

    switch (event.type) {
      case 'speech_start':
        if (this.state === 'idle') {
          this.state = 'listening';
          this.openStream();
          this.stream!.write(chunk);
          this.emit('speech_start');
        }
        break;

      case 'speech_end':
        if (this.state === 'listening') {
          this.emit('speech_end');
          void this.finishListening();
        }
        break;

      case 'speech':
        if (this.state === 'listening' && this.stream) {
          this.stream.write(chunk);
        }
        break;
    }
  }

  private handleNoVAD(chunk: Buffer): void {
    if (this.state === 'idle') {
      this.state = 'listening';
      this.openStream();
    }

    if (this.state === 'listening' && this.stream) {
      this.stream.write(chunk);
    }
  }

  private openStream(): void {
    this.stream = this.stt.createStream();

    this.stream.on('partial', (text: string) => {
      this.emit('transcript', text, false);
    });

    this.stream.on('final', (result: { text: string }) => {
      this.emit('transcript', result.text, true);
    });

    this.stream.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  private async finishListening(): Promise<void> {
    if (!this.stream) return;

    const currentStream = this.stream;
    this.stream = null;
    this.state = 'processing';

    try {
      const result = await currentStream.close();
      currentStream.removeAllListeners();

      if (this.interrupted) {
        this.interrupted = false;
        this.state = 'idle';
        return;
      }

      const { content } = await this.agent.run(result.text);
      this.emit('agent_response', content);

      if (this.interrupted) {
        this.interrupted = false;
        this.state = 'idle';
        return;
      }

      this.state = 'speaking';
      const generator = this.tts.streamSynthesize(content);

      for await (const audioChunk of generator) {
        if (this.interrupted) break;
        this.emit('audio', audioChunk);
      }

      this.interrupted = false;
      this.state = 'idle';
    } catch (err) {
      this.state = 'idle';
      this.interrupted = false;
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }
}
