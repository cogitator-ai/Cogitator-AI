import { EventEmitter } from 'node:events';
import type http from 'node:http';
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

const WS_INTERNAL_ERROR = 1011;
const MAX_CLOSE_REASON_BYTES = 120;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function closeReason(message: string): string {
  const buf = Buffer.from(message);
  if (buf.length <= MAX_CLOSE_REASON_BYTES) return message;
  return buf.subarray(0, MAX_CLOSE_REASON_BYTES).toString().replace(/�+$/, '');
}

/**
 * Serves voice sessions over WebSocket.
 *
 * Client -> server: binary frames carry PCM16 audio; JSON text frames carry control
 * messages `{ type: 'interrupt' }`, `{ type: 'end_of_speech' }` and `{ type: 'text', text }`.
 * Server -> client: binary audio frames and JSON events (`transcript`, `agent_response`,
 * `speech_start`, `speech_end`, `turn_end`).
 */
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
        ttsOptions: config.ttsOptions,
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
    const transport = this.createTransport();
    try {
      await transport.listen(port);
    } catch (err) {
      this.transport = null;
      await transport.close().catch(() => {});
      throw err;
    }
  }

  /** Serve voice sessions on an existing HTTP server (shares its port). */
  attach(server: http.Server): void {
    this.createTransport().attachToServer(server);
  }

  async close(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();

    await Promise.allSettled(entries.map(([, entry]) => this.cleanupSession(entry)));
    for (const [id] of entries) {
      this.emit('session_end', id);
    }

    if (this.transport) {
      const transport = this.transport;
      this.transport = null;
      await transport.close();
    }
  }

  private createTransport(): WebSocketTransport {
    if (this.transport) {
      throw new Error('VoiceAgent is already listening — call close() first');
    }
    const transport = new WebSocketTransport(this.config.transport);
    transport.on('connection', (client) => this.handleConnection(client));
    this.transport = transport;
    return transport;
  }

  private validateConfig(config: VoiceAgentConfig): void {
    if (config.mode === 'pipeline') {
      if (!config.stt) throw new Error('stt is required for pipeline mode');
      if (!config.tts) throw new Error('tts is required for pipeline mode');
    } else if (config.mode === 'realtime') {
      if (!config.realtimeProvider)
        throw new Error('realtimeProvider is required for realtime mode');
      if (!config.realtimeApiKey) throw new Error('realtimeApiKey is required for realtime mode');
    } else {
      throw new Error(`Unknown mode: ${String((config as { mode: unknown }).mode)}`);
    }
  }

  private handleConnection(client: VoiceClient): void {
    const sessionId = client.id;
    const entry: SessionEntry = { client };

    this.sessions.set(sessionId, entry);

    client.on('close', () => {
      if (!this.sessions.delete(sessionId)) return;
      void this.cleanupSession(entry).catch((err: unknown) => this.reportError(toError(err)));
      this.emit('session_end', sessionId);
    });

    client.on('error', (err) => {
      this.reportError(err);
    });

    client.on('message', (msg) => this.handleControlMessage(entry, msg));

    if (this.config.mode === 'pipeline') {
      this.setupPipelineSession(entry);
    } else {
      this.setupRealtimeSession(entry);
    }

    this.emit('session_start', sessionId);
  }

  private handleControlMessage(entry: SessionEntry, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'interrupt':
        entry.pipelineSession?.interrupt();
        entry.realtimeSession?.interrupt();
        break;

      case 'end_of_speech':
        entry.pipelineSession?.endAudio();
        break;

      case 'text':
        if (typeof msg.text !== 'string' || msg.text.trim().length === 0) {
          this.reportError(new Error('Control message "text" requires a non-empty text field'));
          return;
        }
        if (entry.pipelineSession) {
          void entry.pipelineSession.sendText(msg.text);
        }
        entry.realtimeSession?.sendText(msg.text);
        break;

      default:
        this.reportError(new Error(`Unknown control message type: ${String(msg.type)}`));
    }
  }

  private setupPipelineSession(entry: SessionEntry): void {
    const session = this.pipeline!.createSession({ sessionId: entry.client.id });
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

    session.on('turn_end', () => {
      entry.client.sendMessage({ type: 'turn_end' });
    });

    session.on('error', (err: Error) => {
      this.reportError(err);
    });
  }

  private setupRealtimeSession(entry: SessionEntry): void {
    const session = new RealtimeSession({
      provider: this.config.realtimeProvider!,
      apiKey: this.config.realtimeApiKey!,
      model: this.config.realtimeModel,
      voice: this.config.voice,
      instructions: this.config.instructions ?? this.config.agent.instructions,
      tools: this.config.tools,
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

    session.on('turn_end', () => {
      entry.client.sendMessage({ type: 'turn_end' });
    });

    session.on('error', (err: Error) => {
      this.reportError(err);
    });

    session.on('disconnected', (code: number, reason: string) => {
      if (!this.sessions.has(entry.client.id)) return;
      entry.client.close(
        WS_INTERNAL_ERROR,
        closeReason(`Realtime provider disconnected (${code}): ${reason}`)
      );
    });

    session.connect().catch((err: unknown) => {
      if (!this.sessions.has(entry.client.id)) return;
      const error = toError(err);
      this.reportError(error);
      entry.client.close(
        WS_INTERNAL_ERROR,
        closeReason(`Realtime connect failed: ${error.message}`)
      );
    });
  }

  private reportError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  private async cleanupSession(entry: SessionEntry): Promise<void> {
    entry.realtimeSession?.close();
    if (entry.pipelineSession) {
      await entry.pipelineSession.close();
    }
  }
}
