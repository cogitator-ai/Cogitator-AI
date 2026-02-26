import { EventEmitter } from 'node:events';
import type { STTStream, VoicePipelineConfig } from '../types.js';
import { pcm16ToFloat32 } from '../audio.js';

type SessionState = 'idle' | 'listening' | 'processing' | 'speaking';

interface PipelineSessionEvents {
  speech_start: [];
  speech_end: [];
  transcript: [text: string, isFinal: boolean];
  agent_response: [content: string];
  audio: [chunk: Buffer];
  error: [error: Error];
}

export class PipelineSession extends EventEmitter<PipelineSessionEvents> {
  private readonly stt: VoicePipelineConfig['stt'];
  private readonly tts: VoicePipelineConfig['tts'];
  private readonly vad: VoicePipelineConfig['vad'];
  private readonly agent: VoicePipelineConfig['agent'];
  private state: SessionState = 'idle';
  private stream: STTStream | null = null;
  private interrupted = false;
  private closed = false;
  private activeProcessing: Promise<void> | null = null;

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
      void this.handleVAD(chunk);
    } else {
      this.handleNoVAD(chunk);
    }
  }

  endAudio(): void {
    if (this.state === 'listening') {
      void this.finishListening();
    }
  }

  interrupt(): void {
    this.interrupted = true;

    if (this.stream) {
      this.stream.removeAllListeners();
      void this.stream.close().catch(() => {});
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
      void this.stream.close().catch(() => {});
      this.stream = null;
    }

    if (this.activeProcessing) {
      await this.activeProcessing.catch(() => {});
    }

    this.removeAllListeners();
  }

  private async handleVAD(chunk: Buffer): Promise<void> {
    const samples = pcm16ToFloat32(chunk);
    const event = await this.vad!.process(samples);

    switch (event.type) {
      case 'speech_start':
        if (this.state === 'idle') {
          this.state = 'listening';
          this.openStream();
          this.stream?.write(chunk);
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

  private finishListening(): Promise<void> {
    if (!this.stream) return Promise.resolve();

    const currentStream = this.stream;
    this.stream = null;
    this.state = 'processing';

    const processing = (async () => {
      try {
        const result = await currentStream.close();
        currentStream.removeAllListeners();

        if (this.interrupted || this.closed) {
          this.interrupted = false;
          this.state = 'idle';
          return;
        }

        const { content } = await this.agent.run(result.text);
        this.emit('agent_response', content);

        if (this.interrupted || this.closed) {
          this.interrupted = false;
          this.state = 'idle';
          return;
        }

        this.state = 'speaking';
        const generator = this.tts.streamSynthesize(content);

        for await (const audioChunk of generator) {
          if (this.interrupted || this.closed) break;
          this.emit('audio', audioChunk);
        }

        this.interrupted = false;
        this.state = 'idle';
      } catch (err) {
        this.state = 'idle';
        this.interrupted = false;
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      } finally {
        this.activeProcessing = null;
      }
    })();

    this.activeProcessing = processing;
    return processing;
  }
}
