import { EventEmitter } from 'node:events';
import type { VoiceAgentConfig } from './types.js';
import { WebSocketTransport, VoiceClient } from './transport/ws-transport.js';
import { VoicePipeline } from './pipeline/voice-pipeline.js';
import { PipelineSession } from './pipeline/pipeline-session.js';
import { RealtimeSession } from './realtime/realtime-session.js';

interface SessionEntry {
  client: VoiceClient;
  pipelineSession?: PipelineSession;
  realtimeSession?: RealtimeSession;
}

interface VoiceAgentEvents {
  session_start: [sessionId: string];
  session_end: [sessionId: string];
  error: [error: Error];
}

export class VoiceAgent extends EventEmitter<VoiceAgentEvents> {
  private readonly config: VoiceAgentConfig;
  private transport: WebSocketTransport | null = null;
  private readonly sessions = new Map<string, SessionEntry>();
  private pipeline: VoicePipeline | null = null;

  constructor(config: VoiceAgentConfig) {
    super();
    this.validateConfig(config);
    this.config = config;

    if (config.mode === 'pipeline') {
      this.pipeline = new VoicePipeline({
        stt: config.stt!,
        tts: config.tts!,
        vad: config.vad,
        agent: config.agent,
      });
    }
  }

  get port(): number | undefined {
    return this.transport?.port;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }

  async listen(port: number): Promise<void> {
    this.transport = new WebSocketTransport(this.config.transport);
    this.transport.on('connection', (client) => this.handleConnection(client));
    await this.transport.listen(port);
  }

  async close(): Promise<void> {
    for (const [id, entry] of this.sessions) {
      await this.cleanupSession(id, entry);
    }
    this.sessions.clear();

    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }

  private validateConfig(config: VoiceAgentConfig): void {
    if (config.mode === 'pipeline') {
      if (!config.stt) throw new Error('stt is required for pipeline mode');
      if (!config.tts) throw new Error('tts is required for pipeline mode');
    } else if (config.mode === 'realtime') {
      if (!config.realtimeProvider)
        throw new Error('realtimeProvider is required for realtime mode');
      if (!config.realtimeApiKey) throw new Error('realtimeApiKey is required for realtime mode');
    }
  }

  private handleConnection(client: VoiceClient): void {
    const sessionId = client.id;

    const entry: SessionEntry = { client };

    if (this.config.mode === 'pipeline') {
      this.setupPipelineSession(sessionId, entry);
    } else {
      this.setupRealtimeSession(sessionId, entry);
    }

    this.sessions.set(sessionId, entry);
    this.emit('session_start', sessionId);

    client.on('close', () => {
      void this.cleanupSession(sessionId, entry);
      this.sessions.delete(sessionId);
      this.emit('session_end', sessionId);
    });

    client.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private setupPipelineSession(sessionId: string, entry: SessionEntry): void {
    const session = this.pipeline!.createSession();
    entry.pipelineSession = session;

    entry.client.on('audio', (chunk) => {
      session.pushAudio(chunk);
    });

    session.on('audio', (chunk: Buffer) => {
      entry.client.sendAudio(chunk);
    });

    session.on('transcript', (text: string, isFinal: boolean) => {
      entry.client.sendMessage({ type: 'transcript', text, isFinal });
    });

    session.on('agent_response', (text: string) => {
      entry.client.sendMessage({ type: 'agent_response', text });
    });

    session.on('speech_start', () => {
      entry.client.sendMessage({ type: 'speech_start' });
    });

    session.on('speech_end', () => {
      entry.client.sendMessage({ type: 'speech_end' });
    });

    session.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private setupRealtimeSession(_sessionId: string, entry: SessionEntry): void {
    const session = new RealtimeSession({
      provider: this.config.realtimeProvider!,
      apiKey: this.config.realtimeApiKey!,
      model: this.config.realtimeModel,
      voice: this.config.voice,
    });
    entry.realtimeSession = session;

    entry.client.on('audio', (chunk) => {
      session.pushAudio(chunk);
    });

    session.on('audio', (chunk: Buffer) => {
      entry.client.sendAudio(chunk);
    });

    session.on('transcript', (text: string, role: 'user' | 'assistant') => {
      entry.client.sendMessage({ type: 'transcript', text, role });
    });

    session.on('speech_start', () => {
      entry.client.sendMessage({ type: 'speech_start' });
    });

    session.on('error', (err: Error) => {
      this.emit('error', err);
    });

    void session.connect().catch((err: unknown) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async cleanupSession(_id: string, entry: SessionEntry): Promise<void> {
    if (entry.pipelineSession) {
      await entry.pipelineSession.close();
    }
    if (entry.realtimeSession) {
      entry.realtimeSession.close();
    }
  }
}
