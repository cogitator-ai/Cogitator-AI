import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { RealtimeSessionConfig } from '../types.js';

const DEFAULT_MODEL = 'gpt-4o-mini-realtime-preview';
const BASE_URL = 'wss://api.openai.com/v1/realtime';

interface OpenAIRealtimeEvents {
  connected: [];
  audio: [chunk: Buffer];
  transcript: [text: string, role: 'user' | 'assistant'];
  tool_call: [name: string, args: unknown];
  speech_start: [];
  error: [error: Error];
}

export class OpenAIRealtimeAdapter extends EventEmitter<OpenAIRealtimeEvents> {
  private readonly config: RealtimeSessionConfig;
  private readonly model: string;
  private ws: WebSocket | null = null;

  constructor(config: RealtimeSessionConfig) {
    super();
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    const url = `${BASE_URL}?model=${this.model}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.on('open', () => {
        this.sendSessionUpdate();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer | string) => {
        this.handleMessage(typeof data === 'string' ? data : data.toString());
      });

      this.ws.on('error', (err: Error) => {
        this.emit('error', err);
        reject(err);
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
    this.send({ type: 'response.cancel' });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private sendSessionUpdate(): void {
    const session: Record<string, unknown> = {
      voice: this.config.voice ?? 'coral',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: { type: 'server_vad' },
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
    }

    this.send({ type: 'session.update', session });
  }

  private handleMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.emit('error', new Error('Failed to parse WebSocket message'));
      return;
    }
    const type = event.type as string;

    switch (type) {
      case 'response.audio.delta':
        this.emit('audio', Buffer.from(event.delta as string, 'base64'));
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.emit('transcript', event.transcript as string, 'user');
        break;

      case 'response.audio_transcript.done':
        this.emit('transcript', event.transcript as string, 'assistant');
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech_start');
        break;

      case 'response.function_call_arguments.done':
        void this.handleToolCall(event);
        break;

      case 'error': {
        const errObj = event.error as { message: string; code?: string };
        this.emit('error', new Error(errObj.message));
        break;
      }
    }
  }

  private async handleToolCall(event: Record<string, unknown>): Promise<void> {
    const name = event.name as string;
    const callId = event.call_id as string;
    let args: unknown;
    try {
      args = JSON.parse(event.arguments as string);
    } catch {
      this.emit('error', new Error(`Failed to parse tool call arguments for ${name}`));
      return;
    }

    this.emit('tool_call', name, args);

    const tool = this.config.tools?.find((t) => t.name === name);
    if (!tool) return;

    let output: string;
    try {
      const result = await tool.execute(args);
      output = JSON.stringify(result);
    } catch (err) {
      output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    });
    this.send({ type: 'response.create' });
  }

  private send(data: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
