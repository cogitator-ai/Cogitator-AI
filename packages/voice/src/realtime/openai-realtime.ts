import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { RealtimeSessionConfig } from '../types.js';

const DEFAULT_MODEL = 'gpt-realtime-mini';
const DEFAULT_VOICE = 'marin';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const BASE_URL = 'wss://api.openai.com/v1/realtime';
const CONNECT_TIMEOUT_MS = 30_000;
const PCM_FORMAT = { type: 'audio/pcm', rate: 24000 } as const;

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

interface FunctionCallItem {
  name: string;
  callId: string;
  arguments: string;
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
 * OpenAI Realtime API (GA interface) adapter. Audio in both directions is
 * PCM16 mono at 24kHz.
 */
export class OpenAIRealtimeAdapter extends EventEmitter<OpenAIRealtimeEvents> {
  private readonly config: RealtimeSessionConfig;
  private readonly model: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private responseActive = false;

  constructor(config: RealtimeSessionConfig) {
    super();
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
    this.send({ type: 'response.create' });
  }

  interrupt(): void {
    if (!this.responseActive) return;
    this.send({ type: 'response.cancel' });
  }

  close(): void {
    const ws = this.ws;
    this.connected = false;
    this.responseActive = false;
    if (!ws) return;
    this.ws = null;
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.close();
  }

  private sendSessionUpdate(): void {
    const session: Record<string, unknown> = {
      type: 'realtime',
      output_modalities: ['audio'],
      audio: {
        input: {
          format: PCM_FORMAT,
          transcription: { model: DEFAULT_TRANSCRIPTION_MODEL },
          turn_detection: { type: 'server_vad' },
        },
        output: {
          format: PCM_FORMAT,
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
        this.emit('audio', Buffer.from(delta, 'base64'));
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
    const outputs = await Promise.all(calls.map((call) => this.executeToolCall(call)));
    if (this.ws !== ws) return;

    for (const { callId, output } of outputs) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      });
    }
    this.send({ type: 'response.create' });
  }

  private async executeToolCall(
    call: FunctionCallItem
  ): Promise<{ callId: string; output: string }> {
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      return {
        callId: call.callId,
        output: JSON.stringify({ error: `Invalid JSON arguments for tool ${call.name}` }),
      };
    }

    this.emit('tool_call', call.name, args);

    const tool = this.config.tools?.find((t) => t.name === call.name);
    if (!tool) {
      return {
        callId: call.callId,
        output: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
      };
    }

    try {
      const result = await tool.execute(args);
      return { callId: call.callId, output: JSON.stringify(result ?? null) };
    } catch (err) {
      return {
        callId: call.callId,
        output: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      };
    }
  }

  private send(data: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
