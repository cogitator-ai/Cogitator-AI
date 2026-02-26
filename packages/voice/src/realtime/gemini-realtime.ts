import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { RealtimeSessionConfig } from '../types.js';

const DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
const BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

interface GeminiRealtimeEvents {
  connected: [];
  audio: [chunk: Buffer];
  transcript: [text: string, role: 'user' | 'assistant'];
  tool_call: [name: string, args: unknown];
  speech_start: [];
  error: [error: Error];
}

interface GeminiServerContent {
  modelTurn?: {
    parts: Array<{
      text?: string;
      inlineData?: { mimeType: string; data: string };
    }>;
  };
  turnComplete?: boolean;
}

interface GeminiFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface GeminiMessage {
  setupComplete?: Record<string, never>;
  serverContent?: GeminiServerContent;
  toolCall?: {
    functionCalls: GeminiFunctionCall[];
  };
}

export class GeminiRealtimeAdapter extends EventEmitter<GeminiRealtimeEvents> {
  private readonly config: RealtimeSessionConfig;
  private readonly model: string;
  private ws: WebSocket | null = null;

  constructor(config: RealtimeSessionConfig) {
    super();
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    const url = `${BASE_URL}?key=${this.config.apiKey}`;

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.sendSetup();
      });

      this.ws.on('message', (data: Buffer | string) => {
        const raw = typeof data === 'string' ? data : data.toString();
        let msg: GeminiMessage;
        try {
          msg = JSON.parse(raw) as GeminiMessage;
        } catch {
          this.emit('error', new Error('Failed to parse WebSocket message'));
          return;
        }

        if (msg.setupComplete) {
          this.emit('connected');
          resolve();
          return;
        }

        this.handleMessage(msg);
      });

      this.ws.on('error', (err: Error) => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  pushAudio(chunk: Buffer): void {
    this.send({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: chunk.toString('base64'),
          },
        ],
      },
    });
  }

  sendText(text: string): void {
    this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  interrupt(): void {
    this.send({
      clientContent: { turnComplete: true },
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private sendSetup(): void {
    const setup: Record<string, unknown> = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.voice ?? 'Puck',
            },
          },
        },
      },
    };

    if (this.config.instructions) {
      setup.systemInstruction = {
        parts: [{ text: this.config.instructions }],
      };
    }

    if (this.config.tools?.length) {
      setup.tools = [
        {
          functionDeclarations: this.config.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    this.send({ setup });
  }

  private handleMessage(msg: GeminiMessage): void {
    if (msg.serverContent) {
      this.handleServerContent(msg.serverContent);
    }

    if (msg.toolCall) {
      void this.handleToolCalls(msg.toolCall.functionCalls);
    }
  }

  private handleServerContent(content: GeminiServerContent): void {
    if (!content.modelTurn?.parts) return;

    for (const part of content.modelTurn.parts) {
      if (part.inlineData) {
        this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
      }
      if (part.text) {
        this.emit('transcript', part.text, 'assistant');
      }
    }
  }

  private async handleToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    const responses = await Promise.all(
      calls.map(async (call) => {
        this.emit('tool_call', call.name, call.args);

        const tool = this.config.tools?.find((t) => t.name === call.name);
        if (!tool) {
          return {
            id: call.id,
            name: call.name,
            response: { result: JSON.stringify({ error: `Unknown tool: ${call.name}` }) },
          };
        }

        let result: string;
        try {
          const output = await tool.execute(call.args);
          result = JSON.stringify(output);
        } catch (err) {
          result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }

        return {
          id: call.id,
          name: call.name,
          response: { result },
        };
      })
    );

    this.send({
      toolResponse: { functionResponses: responses },
    });
  }

  private send(data: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
