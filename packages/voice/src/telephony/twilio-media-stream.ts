import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { RawAudioFormat, VoicePlayback } from '../types.js';
import { AudioTranscoder } from '../transcoder.js';

/** The audio of a Twilio media stream: μ-law at 8 kHz, mono */
export const TWILIO_AUDIO_FORMAT: Readonly<RawAudioFormat> = Object.freeze({
  encoding: 'mulaw',
  sampleRate: 8000,
});

const TWILIO_MEDIA_ENCODING = 'audio/x-mulaw';
const DEFAULT_FRAME_MS = 20;
const WS_POLICY_VIOLATION = 1008;
const WS_UNSUPPORTED_DATA = 1003;

const numeric = z.union([z.number(), z.string()]).transform(Number);

const startEvent = z.object({
  event: z.literal('start'),
  streamSid: z.string().optional(),
  start: z.object({
    streamSid: z.string().min(1),
    callSid: z.string().min(1),
    accountSid: z.string().min(1),
    tracks: z.array(z.string()).default([]),
    customParameters: z.record(z.string(), z.string()).default({}),
    mediaFormat: z.object({
      encoding: z.string(),
      sampleRate: numeric,
      channels: numeric,
    }),
  }),
});

const inboundEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('connected') }),
  startEvent,
  z.object({
    event: z.literal('media'),
    streamSid: z.string().optional(),
    media: z.object({
      track: z.string().optional(),
      chunk: numeric.optional(),
      timestamp: numeric.optional(),
      payload: z.string(),
    }),
  }),
  z.object({
    event: z.literal('mark'),
    streamSid: z.string().optional(),
    mark: z.object({ name: z.string() }),
  }),
  z.object({
    event: z.literal('dtmf'),
    streamSid: z.string().optional(),
    dtmf: z.object({ digit: z.string(), track: z.string().optional() }),
  }),
  z.object({ event: z.literal('stop'), streamSid: z.string().optional() }),
]);

const KNOWN_EVENTS = new Set(['connected', 'start', 'media', 'mark', 'dtmf', 'stop']);

/** The `start` event of a media stream */
export interface TwilioStreamStart {
  streamSid: string;
  callSid: string;
  accountSid: string;
  tracks: string[];
  /** The `<Parameter>`s of the TwiML `<Stream>` */
  customParameters: Record<string, string>;
  mediaFormat: { encoding: string; sampleRate: number; channels: number };
}

export interface TwilioMediaStreamOptions {
  /** Format of the audio the `audio` event carries (default μ-law at 8 kHz, as Twilio sends it) */
  inbound?: RawAudioFormat;
  /**
   * Format of the audio `sendAudio` gets (default μ-law at 8 kHz). Other formats are resampled
   * and encoded to μ-law at 8 kHz.
   */
  outbound?: RawAudioFormat;
  /** Length of the outbound `media` messages, in ms (default 20, 160 bytes) */
  frameMs?: number;
  /**
   * Decides whether the stream may go on, from its `start` event. A stream refused, or whose
   * check fails, is closed with 1008. Audio that arrives before the answer is dropped.
   */
  authorize?: (start: TwilioStreamStart) => boolean | Promise<boolean>;
}

interface TwilioMediaStreamEvents {
  /** The stream started and was authorized */
  start: [start: TwilioStreamStart];
  /** Caller audio in the `inbound` format */
  audio: [chunk: Buffer];
  /** A key the caller pressed */
  dtmf: [digit: string];
  /** A mark came back: played, or dropped by `clear` or the end of the call */
  mark: [name: string, played: boolean];
  /** Twilio ended the stream (the call hung up or moved on) */
  stop: [];
  close: [];
  error: [error: Error];
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();
  return data.toString();
}

/**
 * One Twilio media stream (`<Connect><Stream>`, bidirectional) over a WebSocket. It reads
 * Twilio's JSON events, emits the caller's audio and key presses, and sends audio back as
 * base64 μ-law `media` messages in frames of `frameMs`. As a `VoicePlayback`, `mark()` sends a
 * `mark` and resolves once Twilio played the audio before it, and `clear()` sends `clear`, which
 * drops the audio Twilio still holds: the marks pending then resolve false, their audio was not
 * heard. A mark that comes back after `clear` was sent counts as not heard, also when the audio
 * before it finished playing just before.
 */
export class TwilioMediaStream
  extends EventEmitter<TwilioMediaStreamEvents>
  implements VoicePlayback
{
  readonly id: string;
  private readonly inbound: AudioTranscoder;
  private readonly outbound: AudioTranscoder;
  private readonly frameBytes: number;
  private readonly authorize: TwilioMediaStreamOptions['authorize'];
  private state: 'waiting' | 'authorizing' | 'started' | 'ended' = 'waiting';
  private info: TwilioStreamStart | null = null;
  private frame: Buffer[] = [];
  private frameLength = 0;
  private markSeq = 0;
  private readonly pending = new Map<string, (played: boolean) => void>();
  private mediaSinceMark = false;
  private alive = true;

  constructor(
    private readonly ws: WebSocket,
    options: TwilioMediaStreamOptions = {}
  ) {
    super();
    this.id = nanoid();
    this.inbound = new AudioTranscoder(TWILIO_AUDIO_FORMAT, options.inbound ?? TWILIO_AUDIO_FORMAT);
    this.outbound = new AudioTranscoder(
      options.outbound ?? TWILIO_AUDIO_FORMAT,
      TWILIO_AUDIO_FORMAT
    );
    const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    if (!(frameMs > 0)) throw new RangeError(`frameMs must be positive, got ${frameMs}`);
    this.frameBytes = Math.max(1, Math.round((TWILIO_AUDIO_FORMAT.sampleRate * frameMs) / 1000));
    this.authorize = options.authorize;

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.alive = true;
      if (isBinary) {
        this.fail(new Error('Twilio media stream sent a binary frame'));
        return;
      }
      this.handleMessage(rawDataToString(data));
    });
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('close', () => {
      this.state = 'ended';
      this.settleMarks(false);
      this.emit('close');
    });
    ws.on('error', (err) => this.fail(err));
  }

  /** The `start` event, once the stream started and was authorized */
  get start(): TwilioStreamStart | null {
    return this.state === 'started' || this.state === 'ended' ? this.info : null;
  }

  get streamSid(): string | undefined {
    return this.info?.streamSid;
  }

  get callSid(): string | undefined {
    return this.info?.callSid;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  markDead(): void {
    this.alive = false;
  }

  ping(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping();
  }

  /** Sends audio to the caller, in the `outbound` format */
  sendAudio(chunk: Buffer): void {
    if (!this.canSend()) return;
    this.queue(this.outbound.push(chunk));
  }

  /**
   * Sends a `mark` after the audio sent so far, which Twilio echoes once that audio was played.
   * Resolves true then, false when `clear` dropped it or the stream ended first.
   */
  mark(): Promise<boolean> {
    if (!this.canSend()) return Promise.resolve(false);
    this.queue(this.outbound.flush());
    this.sendFrames(true);
    const name = `m${++this.markSeq}`;
    const played = new Promise<boolean>((resolve) => {
      this.pending.set(name, (value) => {
        this.emit('mark', name, value);
        resolve(value);
      });
    });
    this.mediaSinceMark = false;
    this.send({ event: 'mark', streamSid: this.info!.streamSid, mark: { name } });
    return played;
  }

  /** Drops the audio Twilio has not played yet, and the pending marks with it */
  clear(): void {
    this.outbound.reset();
    this.frame = [];
    this.frameLength = 0;
    const queued = this.pending.size > 0 || this.mediaSinceMark;
    this.mediaSinceMark = false;
    if (queued && this.canSend()) {
      this.send({ event: 'clear', streamSid: this.info!.streamSid });
    }
    this.settleMarks(false);
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  terminate(): void {
    this.ws.terminate();
  }

  private canSend(): boolean {
    return this.state === 'started' && this.ws.readyState === WebSocket.OPEN;
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      this.fail(new Error(`Invalid JSON from Twilio: ${(err as Error).message}`));
      return;
    }
    const kind = (json as { event?: unknown } | null)?.event;
    if (typeof kind !== 'string' || !KNOWN_EVENTS.has(kind)) return;
    const parsed = inboundEvent.safeParse(json);
    if (!parsed.success) {
      this.fail(new Error(`Malformed Twilio ${kind} event: ${parsed.error.message}`));
      return;
    }
    const message = parsed.data;
    if (
      message.event !== 'connected' &&
      message.event !== 'start' &&
      this.info &&
      message.streamSid !== undefined &&
      message.streamSid !== this.info.streamSid
    ) {
      return;
    }

    switch (message.event) {
      case 'connected':
        break;
      case 'start':
        void this.handleStart(message.start);
        break;
      case 'media':
        if (this.state !== 'started') return;
        if (message.media.track !== undefined && message.media.track !== 'inbound') return;
        this.emitAudio(Buffer.from(message.media.payload, 'base64'));
        break;
      case 'mark':
        this.handleMark(message.mark.name);
        break;
      case 'dtmf':
        if (this.state === 'started') this.emit('dtmf', message.dtmf.digit);
        break;
      case 'stop':
        if (this.state === 'ended') return;
        this.state = 'ended';
        this.settleMarks(false);
        this.emit('stop');
        this.ws.close(1000, 'stream stopped');
        break;
    }
  }

  private async handleStart(start: TwilioStreamStart): Promise<void> {
    if (this.state !== 'waiting') {
      this.fail(new Error('Twilio media stream started twice'));
      return;
    }
    const format = start.mediaFormat;
    if (
      format.encoding !== TWILIO_MEDIA_ENCODING ||
      format.sampleRate !== TWILIO_AUDIO_FORMAT.sampleRate ||
      format.channels !== 1
    ) {
      this.state = 'ended';
      this.emit(
        'error',
        new Error(
          `Unsupported Twilio media format ${format.encoding} ${format.sampleRate} Hz ${format.channels}ch`
        )
      );
      this.ws.close(WS_UNSUPPORTED_DATA, 'unsupported media format');
      return;
    }

    this.info = start;
    this.state = 'authorizing';
    let allowed: boolean;
    try {
      allowed = this.authorize ? await this.authorize(start) : true;
    } catch (err) {
      allowed = false;
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
    if (this.state !== 'authorizing') return;
    if (!allowed) {
      this.state = 'ended';
      this.fail(new Error(`Twilio media stream ${start.streamSid} was refused`));
      this.ws.close(WS_POLICY_VIOLATION, 'unauthorized');
      return;
    }
    this.state = 'started';
    try {
      this.emit('start', start);
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private emitAudio(payload: Buffer): void {
    if (payload.length === 0) return;
    const audio = this.inbound.push(payload);
    if (audio.length > 0) this.emit('audio', audio);
  }

  /** A mark came back: it and every mark sent before it were played */
  private handleMark(name: string): void {
    if (!this.pending.has(name)) return;
    for (const [pendingName, resolve] of this.pending) {
      this.pending.delete(pendingName);
      resolve(true);
      if (pendingName === name) break;
    }
  }

  private settleMarks(played: boolean): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of pending) resolve(played);
  }

  private queue(audio: Buffer): void {
    if (audio.length === 0) return;
    this.frame.push(audio);
    this.frameLength += audio.length;
    this.sendFrames(false);
  }

  /** Sends the queued audio in whole frames, and the rest too when `all` */
  private sendFrames(all: boolean): void {
    if (this.frameLength === 0) return;
    if (!all && this.frameLength < this.frameBytes) return;
    const audio = this.frame.length === 1 ? this.frame[0]! : Buffer.concat(this.frame);
    const whole = all ? audio.length : audio.length - (audio.length % this.frameBytes);
    for (let offset = 0; offset < whole; offset += this.frameBytes) {
      const end = Math.min(offset + this.frameBytes, whole);
      this.send({
        event: 'media',
        streamSid: this.info!.streamSid,
        media: { payload: audio.subarray(offset, end).toString('base64') },
      });
    }
    if (whole > 0) this.mediaSinceMark = true;
    const rest = audio.subarray(whole);
    this.frame = rest.length > 0 ? [Buffer.from(rest)] : [];
    this.frameLength = rest.length;
  }

  private fail(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
}
