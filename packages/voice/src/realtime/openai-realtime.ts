import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { ToolImagePart } from '@cogitator-ai/types';
import type { RealtimeSessionConfig } from '../types.js';
import {
  assertRealtimeTools,
  realtimeToolError,
  realtimeToolParts,
  realtimeToolText,
} from './tool-output.js';

const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
const DEFAULT_VOICE = 'marin';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
const BASE_URL = 'wss://api.openai.com/v1/realtime';
const CONNECT_TIMEOUT_MS = 30_000;
const PCM_FORMAT = { type: 'audio/pcm', rate: 24000 } as const;
const PCMU_FORMAT = { type: 'audio/pcmu' } as const;
/** Longest wait for the active response to end before a new one is created anyway */
const CREATE_WAIT_MS = 3_000;
/** Audio items kept for truncation, the oldest dropped first */
const MAX_AUDIO_ITEMS = 64;

interface OpenAIRealtimeEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  audio: [chunk: Buffer];
  transcript: [text: string, role: 'user' | 'assistant'];
  tool_call: [name: string, args: unknown];
  speech_start: [];
  turn_end: [];
  error: [error: Error];
}

/** The assistant audio item being played, placed on the timeline of all audio emitted */
interface AudioItem {
  itemId: string;
  contentIndex: number;
  /** Where the item starts on the session's audio timeline, in ms */
  start: number;
  /** How much audio of the item was emitted, in ms */
  ms: number;
  truncated: boolean;
}

interface FunctionCallItem {
  name: string;
  callId: string;
  arguments: string;
}

interface ToolCallOutput {
  callId: string;
  name: string;
  output: string;
  images: ToolImagePart[];
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();
  return data.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * OpenAI Realtime API (GA interface) adapter. Audio in both directions is PCM16 mono at 24kHz,
 * or G.711 μ-law at 8 kHz (`audio/pcmu`) with `audioFormat: 'pcmu'`.
 */
export class OpenAIRealtimeAdapter extends EventEmitter<OpenAIRealtimeEvents> {
  private readonly config: RealtimeSessionConfig;
  private readonly model: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private responseActive = false;
  private calls: AbortController | null = null;
  private readonly audioItems: AudioItem[] = [];
  private emittedMs = 0;
  private pendingCreate: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RealtimeSessionConfig) {
    super();
    assertRealtimeTools(config.tools);
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      throw new Error('Already connected or connecting — call close() first');
    }

    const url = `${BASE_URL}?model=${encodeURIComponent(this.model)}`;
    this.calls = new AbortController();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
      this.ws = ws;

      const timer = setTimeout(() => {
        if (this.ws === ws) this.ws = null;
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        settle(new Error(`Connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        this.connected = true;
        this.sendSessionUpdate();
        this.emit('connected');
        settle();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(rawDataToString(data));
      });

      ws.on('error', (err: Error) => {
        if (settled) {
          this.emit('error', err);
        } else {
          settle(err);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || 'connection closed';
        if (this.ws === ws) this.ws = null;
        const wasConnected = this.connected;
        this.connected = false;
        this.responseActive = false;
        this.abortCalls(`Realtime connection closed (code ${code})`);
        settle(new Error(`WebSocket closed before connect (code ${code}): ${reasonStr}`));
        if (wasConnected) this.emit('disconnected', code, reasonStr);
      });
    });
  }

  pushAudio(chunk: Buffer): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    });
  }

  sendText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    this.createResponse();
  }

  /**
   * Asks for a response, once the active one ended (`response.done`, as after a cancel) or after
   * `CREATE_WAIT_MS`: a `response.create` while a response is active fails
   */
  private createResponse(): void {
    if (!this.responseActive) {
      this.send({ type: 'response.create' });
      return;
    }
    if (this.pendingCreate) return;
    this.pendingCreate = setTimeout(() => this.flushCreate(), CREATE_WAIT_MS);
    this.pendingCreate.unref();
  }

  private flushCreate(): void {
    if (!this.pendingCreate) return;
    clearTimeout(this.pendingCreate);
    this.pendingCreate = null;
    this.send({ type: 'response.create' });
  }

  interrupt(): void {
    if (!this.responseActive) return;
    this.send({ type: 'response.cancel' });
  }

  /**
   * Tells the model how much of its audio the listener heard: `playedMs` is a position on the
   * timeline of all the audio this adapter emitted. The item playing there is truncated at that
   * point and the items after it at 0 (`conversation.item.truncate`), so the conversation keeps
   * only what was heard. The item of an active response is cut at its end even when all of it
   * was heard, and audio of a truncated item that still arrives is dropped.
   */
  truncate(playedMs: number): void {
    const growing = this.responseActive ? this.audioItems.at(-1) : undefined;
    for (const item of this.audioItems) {
      if (item.truncated) continue;
      const end = Math.min(Math.max(0, Math.floor(playedMs - item.start)), Math.floor(item.ms));
      if (end >= Math.floor(item.ms) && item !== growing) continue;
      item.truncated = true;
      this.send({
        type: 'conversation.item.truncate',
        item_id: item.itemId,
        content_index: item.contentIndex,
        audio_end_ms: end,
      });
    }
  }

  close(): void {
    const ws = this.ws;
    this.connected = false;
    this.responseActive = false;
    if (this.pendingCreate) clearTimeout(this.pendingCreate);
    this.pendingCreate = null;
    this.abortCalls('Realtime session closed');
    if (!ws) return;
    this.ws = null;
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.close();
  }

  private sendSessionUpdate(): void {
    const format = this.config.audioFormat === 'pcmu' ? PCMU_FORMAT : PCM_FORMAT;
    const session: Record<string, unknown> = {
      type: 'realtime',
      output_modalities: ['audio'],
      audio: {
        input: {
          format,
          transcription: { model: DEFAULT_TRANSCRIPTION_MODEL },
          turn_detection: { type: 'server_vad' },
        },
        output: {
          format,
          voice: this.config.voice ?? DEFAULT_VOICE,
        },
      },
    };

    if (this.config.instructions) {
      session.instructions = this.config.instructions;
    }

    if (this.config.tools?.length) {
      session.tools = this.config.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
      session.tool_choice = 'auto';
    }

    this.send({ type: 'session.update', session });
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emit('error', new Error('Failed to parse WebSocket message'));
      return;
    }
    if (!isRecord(parsed)) return;
    const event = parsed;

    switch (event.type) {
      case 'response.output_audio.delta': {
        const delta = event.delta;
        if (typeof delta !== 'string') {
          this.emit(
            'error',
            new Error('Malformed response.output_audio.delta: missing or invalid delta')
          );
          break;
        }
        const audio = Buffer.from(delta, 'base64');
        if (!this.trackAudio(event, audio.length)) break;
        this.emit('audio', audio);
        break;
      }

      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.transcript === 'string') {
          this.emit('transcript', event.transcript, 'user');
        }
        break;

      case 'response.output_audio_transcript.done':
        if (typeof event.transcript === 'string') {
          this.emit('transcript', event.transcript, 'assistant');
        }
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech_start');
        break;

      case 'response.created':
        this.responseActive = true;
        break;

      case 'response.done':
        this.responseActive = false;
        this.flushCreate();
        this.handleResponseDone(event.response);
        break;

      case 'error': {
        const errObj = event.error;
        const message =
          isRecord(errObj) && typeof errObj.message === 'string'
            ? errObj.message
            : 'Unknown server error';
        this.emit('error', new Error(message));
        break;
      }
    }
  }

  /** Places a delta on the audio timeline: false for audio of a truncated item, to drop */
  private trackAudio(event: Record<string, unknown>, bytes: number): boolean {
    const ms = bytes / (this.config.audioFormat === 'pcmu' ? 8 : 48);
    const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
    if (itemId !== undefined) {
      let item = this.audioItems.find((candidate) => candidate.itemId === itemId);
      if (!item) {
        item = {
          itemId,
          contentIndex: typeof event.content_index === 'number' ? event.content_index : 0,
          start: this.emittedMs,
          ms: 0,
          truncated: false,
        };
        this.audioItems.push(item);
        if (this.audioItems.length > MAX_AUDIO_ITEMS) this.audioItems.shift();
      }
      if (item.truncated) return false;
      item.ms += ms;
    }
    this.emittedMs += ms;
    return true;
  }

  private handleResponseDone(response: unknown): void {
    const calls: FunctionCallItem[] = [];
    if (isRecord(response) && response.status === 'completed' && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (
          isRecord(item) &&
          item.type === 'function_call' &&
          typeof item.name === 'string' &&
          typeof item.call_id === 'string'
        ) {
          calls.push({
            name: item.name,
            callId: item.call_id,
            arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
          });
        }
      }
    }

    if (calls.length === 0) {
      this.emit('turn_end');
      return;
    }

    void this.handleToolCalls(calls);
  }

  private async handleToolCalls(calls: FunctionCallItem[]): Promise<void> {
    const ws = this.ws;
    const signal = this.calls?.signal ?? AbortSignal.abort();
    const outputs = await Promise.all(calls.map((call) => this.executeToolCall(call, signal)));
    if (this.ws !== ws) return;

    for (const { callId, output } of outputs) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      });
    }
    if (this.config.toolImages) {
      for (const { name, images } of outputs) {
        if (images.length === 0) continue;
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: `Images returned by the ${name} tool:` },
              ...images.map((image) => ({
                type: 'input_image',
                image_url: `data:${image.mediaType};base64,${image.data}`,
              })),
            ],
          },
        });
      }
    }
    this.send({ type: 'response.create' });
  }

  private async executeToolCall(
    call: FunctionCallItem,
    signal: AbortSignal
  ): Promise<ToolCallOutput> {
    const failed = (error: string): ToolCallOutput => ({
      callId: call.callId,
      name: call.name,
      output: JSON.stringify({ error }),
      images: [],
    });

    let args: unknown;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return failed(`Invalid JSON arguments for tool ${call.name}`);
    }

    this.emit('tool_call', call.name, args);

    const tool = this.config.tools?.find((t) => t.name === call.name);
    if (!tool) return failed(`Unknown tool: ${call.name}`);

    try {
      const result = await tool.execute(args, {
        callId: call.callId,
        signal,
        ...(this.config.sessionId !== undefined && { sessionId: this.config.sessionId }),
      });
      const parts = realtimeToolParts(result, tool);
      return parts
        ? { callId: call.callId, name: call.name, output: parts.text, images: parts.images }
        : {
            callId: call.callId,
            name: call.name,
            output: realtimeToolText(result, tool),
            images: [],
          };
    } catch (err) {
      return failed(realtimeToolError(err, tool));
    }
  }

  /** Cancels the tool calls still running, whose answers have no session to go to. */
  private abortCalls(reason: string): void {
    this.calls?.abort(new Error(reason));
    this.calls = null;
  }

  private send(data: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
