import { EventEmitter } from 'node:events';
import type http from 'node:http';
import type { WebSocket } from 'ws';
import type {
  RawAudioFormat,
  RealtimeAudioFormat,
  RealtimeTool,
  TTSProvider,
  VoiceAgentConfig,
  VoiceAudioFormat,
} from './types.js';
import { UpgradeTransport, WebSocketTransport, VoiceClient } from './transport/ws-transport.js';
import { VoicePipeline } from './pipeline/voice-pipeline.js';
import { PipelineSession } from './pipeline/pipeline-session.js';
import { RealtimeSession } from './realtime/realtime-session.js';
import {
  TWILIO_AUDIO_FORMAT,
  TwilioMediaStream,
  type TwilioStreamStart,
} from './telephony/twilio-media-stream.js';
import {
  TWILIO_SESSION_TOKEN_PARAMETER,
  verifyTwilioUpgrade,
  type TwilioSessionGrant,
  type TwilioSessionTokens,
} from './telephony/twilio-security.js';

interface SessionEntry {
  id: string;
  close(code?: number, reason?: string): void;
  pipelineSession?: PipelineSession;
  realtimeSession?: RealtimeSession;
}

/** A phone call served by a `VoiceAgent`, as its `call_start` event reports it */
export interface TwilioCall {
  /** The voice session of the call: the runner's `sessionId` */
  sessionId: string;
  callSid: string;
  streamSid: string;
  accountSid: string;
  /** The stream's `<Parameter>`s, without the session token */
  customParameters: Record<string, string>;
  /** What the webhook gave `TwilioSessionTokens.issue`, when the stream had a token */
  grant?: TwilioSessionGrant;
}

/** How a `VoiceAgent` accepts a Twilio media stream */
export interface TwilioStreamOptions {
  /**
   * One-time tokens the voice webhook issued: a stream is refused unless its `start` event brings
   * a valid one in the `<Parameter>` `twilioStreamTwiml({ token })` adds
   */
  tokens?: TwilioSessionTokens;
  /**
   * Decides whether a stream may go on, from its `start` event, after the token check. Needed when
   * `tokens` is not set, such as with tokens kept in a shared store
   */
  authorize?: (start: TwilioStreamStart) => boolean | Promise<boolean>;
  /**
   * Turns a key the caller pressed into text the agent gets as the caller's input. Without it
   * (or when it returns nothing) the key is only reported in the `dtmf` event
   */
  dtmfInput?: (digit: string, call: TwilioCall) => string | undefined;
  /**
   * Longest wait for the stream's authorized `start` after the socket opened, in ms (default
   * 10 000). A socket that does not start in time is closed with 1008
   */
  startTimeout?: number;
}

export interface TwilioTransportConfig extends TwilioStreamOptions {
  /** The account's Auth Token, which signs the stream's WebSocket upgrade */
  authToken: string;
  /** The public `wss://` URL of the stream, as in the TwiML `<Stream url>` */
  streamUrl: string;
  /** Path served on the HTTP server (default: the path of `streamUrl`) */
  path?: string;
  /** Most concurrent streams (default 100) */
  maxConnections?: number;
  /** Largest message Twilio may send, in bytes (default 64 KiB) */
  maxPayload?: number;
}

const TWILIO_MAX_PAYLOAD = 64 * 1024;
/** How often a realtime session marks its audio on a call, to learn how much was played */
const REALTIME_MARK_INTERVAL_MS = 200;

interface VoiceAgentEvents {
  session_start: [sessionId: string];
  session_end: [sessionId: string];
  /** A phone call started its voice session */
  call_start: [call: TwilioCall];
  /** The caller of a phone session pressed a key */
  dtmf: [sessionId: string, digit: string];
  error: [error: Error];
}

/** What a phone session asks the TTS for, and what it then sends to the stream */
interface PhoneOutput {
  format: VoiceAudioFormat;
  outbound: RawAudioFormat;
}

function phoneOutput(tts: TTSProvider): PhoneOutput {
  const rates = tts.rawSampleRates;
  if (rates?.mulaw === TWILIO_AUDIO_FORMAT.sampleRate) {
    return { format: 'mulaw', outbound: TWILIO_AUDIO_FORMAT };
  }
  if (rates?.pcm16 !== undefined) {
    return { format: 'pcm16', outbound: { encoding: 'pcm16', sampleRate: rates.pcm16 } };
  }
  throw new Error(
    `TTS provider "${tts.name}" declares no rawSampleRates, so its audio cannot be sent to a phone call`
  );
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
 * `agent_response_delta` with a streaming runner, `speech_start`, `speech_end`, `turn_end`).
 * With `bargeIn`, a `speech_start` while the agent is speaking means its reply was stopped:
 * the client should drop the audio it still has queued.
 *
 * In realtime mode the model gets `tools`, or else the agent's own tools from
 * `agent.realtimeTools()` (see `agentTools`).
 *
 * Phone calls come in through Twilio media streams, see `attachTwilio` and `handleTwilio`.
 */
export class VoiceAgent extends EventEmitter<VoiceAgentEvents> {
  private readonly config: VoiceAgentConfig;
  private transport: WebSocketTransport | null = null;
  private twilioTransport: UpgradeTransport<TwilioMediaStream> | null = null;
  private readonly twilioStreams = new Set<TwilioMediaStream>();
  private readonly sessions = new Map<string, SessionEntry>();
  private pipeline: VoicePipeline | null = null;
  private readonly realtimeTools: RealtimeTool[] | undefined;

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
        bargeIn: config.bargeIn,
        maxSentenceLength: config.maxSentenceLength,
        settleTimeout: config.settleTimeout,
      });
    }
    this.realtimeTools = config.mode === 'realtime' ? resolveRealtimeTools(config) : undefined;
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

  /**
   * Serves Twilio media streams on an existing HTTP server: phone calls whose TwiML connects them
   * with `twilioStreamTwiml`. Each upgrade must carry a valid `X-Twilio-Signature` for
   * `streamUrl`, and each stream must pass `tokens` or `authorize` on its `start` event. The
   * caller's audio is μ-law at 8 kHz: in pipeline mode it goes to the STT as μ-law when the
   * provider takes it (`streamEncodings`), decoded otherwise, and the answer is asked from the
   * TTS as μ-law when it returns that at 8 kHz (`rawSampleRates`), else as PCM16 and transcoded.
   * Sentences are marked on the stream, so the turn settles with what the caller heard, and a
   * barge-in clears the audio Twilio still holds. In realtime mode the session runs with
   * `audioFormat: 'pcmu'`.
   */
  attachTwilio(server: http.Server, config: TwilioTransportConfig): void {
    if (this.twilioTransport) {
      throw new Error('VoiceAgent already serves Twilio streams, call close() first');
    }
    if (!config.authToken) throw new Error('attachTwilio needs the account authToken');
    let path: string;
    try {
      path = config.path ?? new URL(config.streamUrl).pathname;
    } catch {
      throw new Error(`streamUrl is not a URL: ${config.streamUrl}`);
    }
    const output = this.prepareTwilio(config);
    const transport = new UpgradeTransport<TwilioMediaStream>(
      {
        path,
        maxConnections: config.maxConnections,
        maxPayload: config.maxPayload ?? TWILIO_MAX_PAYLOAD,
        verifyClient: (req) =>
          verifyTwilioUpgrade(req, { authToken: config.authToken, streamUrl: config.streamUrl })
            ? true
            : { code: 403, message: 'Forbidden' },
      },
      (ws) => this.acceptTwilio(ws, config, output)
    );
    transport.attachToServer(server);
    this.twilioTransport = transport;
  }

  /**
   * Serves one Twilio media stream on a WebSocket the caller accepted, for a server that handles
   * the upgrade itself. Check the upgrade with `verifyTwilioUpgrade` before accepting it, and cap
   * the connections and the message size (`maxPayload`) on your server. `close()` closes the
   * socket too.
   */
  handleTwilio(ws: WebSocket, options: TwilioStreamOptions): TwilioMediaStream {
    return this.acceptTwilio(ws, options, this.prepareTwilio(options));
  }

  async close(): Promise<void> {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();
    const streams = [...this.twilioStreams];
    this.twilioStreams.clear();

    await Promise.allSettled(entries.map(([, entry]) => this.cleanupSession(entry)));
    for (const [id] of entries) {
      this.emit('session_end', id);
    }
    for (const stream of streams) stream.close(1001, 'server shutting down');

    if (this.transport) {
      const transport = this.transport;
      this.transport = null;
      await transport.close();
    }
    if (this.twilioTransport) {
      const transport = this.twilioTransport;
      this.twilioTransport = null;
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
    const entry: SessionEntry = {
      id: sessionId,
      close: (code, reason) => client.close(code, reason),
    };

    this.sessions.set(sessionId, entry);

    client.on('close', () => this.endSession(entry));

    client.on('error', (err) => {
      this.reportError(err);
    });

    client.on('message', (msg) => this.handleControlMessage(entry, msg));

    if (this.config.mode === 'pipeline') {
      this.setupPipelineSession(entry, client);
    } else {
      this.setupRealtimeSession(entry, client);
    }

    this.emit('session_start', sessionId);
  }

  private endSession(entry: SessionEntry): void {
    if (!this.sessions.delete(entry.id)) return;
    void this.cleanupSession(entry).catch((err: unknown) => this.reportError(toError(err)));
    this.emit('session_end', entry.id);
  }

  /** Checks the options of a Twilio stream, and what the pipeline sends to it */
  private prepareTwilio(options: TwilioStreamOptions): PhoneOutput | null {
    if (!options.tokens && !options.authorize) {
      throw new Error('Twilio streams need tokens or authorize to check each stream');
    }
    if (this.config.mode !== 'pipeline') return null;
    if (!this.config.vad) {
      throw new Error(
        'A pipeline VoiceAgent needs a vad to serve phone calls: Twilio never says when the caller stopped speaking'
      );
    }
    return phoneOutput(this.config.tts!);
  }

  private acceptTwilio(
    ws: WebSocket,
    options: TwilioStreamOptions,
    output: PhoneOutput | null
  ): TwilioMediaStream {
    let grant: TwilioSessionGrant | undefined;
    const stream = new TwilioMediaStream(ws, {
      outbound: output?.outbound ?? TWILIO_AUDIO_FORMAT,
      ...(options.startTimeout !== undefined && { startTimeout: options.startTimeout }),
      authorize: async (start) => {
        if (options.tokens) {
          grant = options.tokens.consume(
            start.customParameters[TWILIO_SESSION_TOKEN_PARAMETER],
            start.callSid
          );
          if (!grant) return false;
        }
        return options.authorize ? options.authorize(start) : true;
      },
    });
    this.twilioStreams.add(stream);
    stream.on('error', (err) => this.reportError(err));
    stream.once('close', () => this.twilioStreams.delete(stream));
    stream.once('start', (start) => {
      if (!this.twilioStreams.has(stream)) return;
      this.startCall(stream, start, grant, options, output);
    });
    return stream;
  }

  private startCall(
    stream: TwilioMediaStream,
    start: TwilioStreamStart,
    grant: TwilioSessionGrant | undefined,
    options: TwilioStreamOptions,
    output: PhoneOutput | null
  ): void {
    const sessionId = stream.id;
    const entry: SessionEntry = {
      id: sessionId,
      close: (code, reason) => stream.close(code, reason),
    };
    const customParameters = { ...start.customParameters };
    delete customParameters[TWILIO_SESSION_TOKEN_PARAMETER];
    const call: TwilioCall = {
      sessionId,
      callSid: start.callSid,
      streamSid: start.streamSid,
      accountSid: start.accountSid,
      customParameters,
      ...(grant && { grant }),
    };
    this.sessions.set(sessionId, entry);
    stream.on('close', () => this.endSession(entry));

    let interruptRealtime: (() => void) | undefined;
    stream.on('dtmf', (digit) => {
      this.emit('dtmf', sessionId, digit);
      let text: string | undefined;
      try {
        text = options.dtmfInput?.(digit, call);
      } catch (err) {
        this.reportError(toError(err));
        return;
      }
      if (!text || text.trim().length === 0) return;
      if (entry.pipelineSession) void entry.pipelineSession.sendText(text);
      if (entry.realtimeSession) {
        interruptRealtime?.();
        entry.realtimeSession.sendText(text);
      }
    });

    if (output) {
      this.setupPhonePipeline(entry, stream, output);
    } else {
      interruptRealtime = this.setupPhoneRealtime(entry, stream);
    }

    this.emit('session_start', sessionId);
    this.emit('call_start', call);
  }

  private setupPhonePipeline(
    entry: SessionEntry,
    stream: TwilioMediaStream,
    output: PhoneOutput
  ): void {
    const session = this.pipeline!.createSession({
      sessionId: entry.id,
      input: TWILIO_AUDIO_FORMAT,
      ttsOptions: { format: output.format },
      playback: stream,
    });
    entry.pipelineSession = session;
    stream.on('audio', (chunk) => session.pushAudio(chunk));
    session.on('audio', (chunk: Buffer) => stream.sendAudio(chunk));
    session.on('error', (err: Error) => this.reportError(err));
  }

  /**
   * Wires a realtime session to a call. The session's audio is marked every 200 ms and at the
   * end of each turn, so the position of the last mark Twilio played is what the caller heard.
   * When the caller speaks, the audio Twilio holds is cleared and the model's answer truncated
   * at that position. Returns the interruption, for a key press that sends text.
   */
  private setupPhoneRealtime(entry: SessionEntry, stream: TwilioMediaStream): () => void {
    const session = this.createRealtimeSession(entry, 'pcmu');
    let sentMs = 0;
    let markedMs = 0;
    let playedMs = 0;
    const markPosition = () => {
      const at = sentMs;
      markedMs = at;
      void stream.mark((played) => {
        if (played) playedMs = Math.max(playedMs, at);
      });
    };
    const interrupt = () => {
      stream.clear();
      session.truncate(playedMs);
    };

    stream.on('audio', (chunk) => session.pushAudio(chunk));
    session.on('audio', (chunk: Buffer) => {
      stream.sendAudio(chunk);
      sentMs += chunk.length / (TWILIO_AUDIO_FORMAT.sampleRate / 1000);
      if (sentMs - markedMs >= REALTIME_MARK_INTERVAL_MS) markPosition();
    });
    session.on('speech_start', interrupt);
    session.on('turn_end', markPosition);
    this.connectRealtime(entry, session);
    return () => {
      session.interrupt();
      interrupt();
    };
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

  private setupPipelineSession(entry: SessionEntry, client: VoiceClient): void {
    const session = this.pipeline!.createSession({ sessionId: entry.id });
    entry.pipelineSession = session;

    client.on('audio', (chunk) => {
      session.pushAudio(chunk);
    });

    session.on('audio', (chunk: Buffer) => {
      client.sendAudio(chunk);
    });

    session.on('transcript', (text: string, isFinal: boolean) => {
      client.sendMessage({ type: 'transcript', text, isFinal });
    });

    session.on('agent_response', (text: string) => {
      client.sendMessage({ type: 'agent_response', text });
    });

    session.on('agent_response_delta', (text: string) => {
      client.sendMessage({ type: 'agent_response_delta', text });
    });

    session.on('speech_start', () => {
      client.sendMessage({ type: 'speech_start' });
    });

    session.on('speech_end', () => {
      client.sendMessage({ type: 'speech_end' });
    });

    session.on('turn_end', () => {
      client.sendMessage({ type: 'turn_end' });
    });

    session.on('error', (err: Error) => {
      this.reportError(err);
    });
  }

  private createRealtimeSession(
    entry: SessionEntry,
    audioFormat: RealtimeAudioFormat
  ): RealtimeSession {
    const session = new RealtimeSession({
      provider: this.config.realtimeProvider!,
      apiKey: this.config.realtimeApiKey!,
      model: this.config.realtimeModel,
      voice: this.config.voice,
      instructions: this.config.instructions ?? this.config.agent.instructions,
      tools: this.realtimeTools,
      sessionId: entry.id,
      toolImages: this.config.toolImages,
      ...(audioFormat === 'pcmu' && { audioFormat }),
    });
    entry.realtimeSession = session;
    session.on('error', (err: Error) => {
      this.reportError(err);
    });
    return session;
  }

  private connectRealtime(entry: SessionEntry, session: RealtimeSession): void {
    session.on('disconnected', (code: number, reason: string) => {
      if (!this.sessions.has(entry.id)) return;
      entry.close(
        WS_INTERNAL_ERROR,
        closeReason(`Realtime provider disconnected (${code}): ${reason}`)
      );
    });

    session.connect().catch((err: unknown) => {
      if (!this.sessions.has(entry.id)) return;
      const error = toError(err);
      this.reportError(error);
      entry.close(WS_INTERNAL_ERROR, closeReason(`Realtime connect failed: ${error.message}`));
    });
  }

  private setupRealtimeSession(entry: SessionEntry, client: VoiceClient): void {
    const session = this.createRealtimeSession(entry, 'pcm');

    client.on('audio', (chunk) => {
      session.pushAudio(chunk);
    });

    session.on('audio', (chunk: Buffer) => {
      client.sendAudio(chunk);
    });

    session.on('transcript', (text: string, role: 'user' | 'assistant') => {
      client.sendMessage({ type: 'transcript', text, role });
    });

    session.on('speech_start', () => {
      client.sendMessage({ type: 'speech_start' });
    });

    session.on('turn_end', () => {
      client.sendMessage({ type: 'turn_end' });
    });

    this.connectRealtime(entry, session);
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

/** `config.tools`, or the agent's own tools unless `agentTools` is false */
function resolveRealtimeTools(config: VoiceAgentConfig): RealtimeTool[] | undefined {
  if (config.tools) return config.tools;
  if (config.agentTools === false || !config.agent.realtimeTools) return undefined;
  const tools = config.agent.realtimeTools(
    typeof config.agentTools === 'object' ? config.agentTools : undefined
  );
  return tools.length > 0 ? tools : undefined;
}
