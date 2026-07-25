import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { RealtimeSessionConfig } from '../types.js';

const DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
const BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const CONNECT_TIMEOUT_MS = 30_000;

interface GeminiRealtimeEvents {
  connected: [];
  disconnected: [code: number, reason: string];
  audio: [chunk: Buffer];
  transcript: [text: string, role: 'user' | 'assistant'];
  tool_call: [name: string, args: unknown];
  speech_start: [];
  turn_end: [];
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
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

interface GeminiMessage {
  setupComplete?: Record<string, never>;
  serverContent?: GeminiServerContent;
  toolCall?: {
    functionCalls: GeminiFunctionCall[];
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class GeminiRealtimeAdapter extends EventEmitter<GeminiRealtimeEvents> {
  private readonly config: RealtimeSessionConfig;
  private readonly model: string;
  private ws: WebSocket | null = null;
  private interrupting = false;

  constructor(config: RealtimeSessionConfig) {
    super();
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      throw new Error('Already connected or connecting — call close() first');
    }

    const url = `${BASE_URL}?key=${this.config.apiKey}`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const ws = new WebSocket(url);
      this.ws = ws;

      const timer = setTimeout(() => {
        this.ws = null;
        ws.removeAllListeners();
        ws.close();
        settleReject(new Error(`Connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        this.sendSetup();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(new Uint8Array(data))
            : data;
        const raw = buf.toString();
        let msg: GeminiMessage;
        try {
          msg = JSON.parse(raw) as GeminiMessage;
        } catch {
          this.emit('error', new Error('Failed to parse WebSocket message'));
          return;
        }

        if (msg.setupComplete) {
          this.emit('connected');
          settleResolve();
          return;
        }

        if (msg.error) {
          const message =
            msg.error.message ?? `Gemini error (code: ${msg.error.code ?? 'unknown'})`;
          const err = new Error(message);
          this.emit('error', err);
          settleReject(err);
          return;
        }

        this.handleMessage(msg);
      });

      ws.on('error', (err: Error) => {
        this.emit('error', err);
        settleReject(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || 'connection closed';
        this.ws = null;
        this.emit('disconnected', code, reasonStr);
        settleReject(new Error(`WebSocket closed before connect (code ${code}): ${reasonStr}`));
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

  /**
   * Gemini Live barge-in is driven by incoming user audio, not a control message.
   * This sets an internal flag that drops inbound model audio until the current
   * turn completes (turnComplete), simulating an interruption on the consumer side.
   */
  interrupt(): void {
    this.interrupting = true;
  }

  close(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.removeAllListeners();
    ws.close();
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
    if (msg.error) {
      const message = msg.error.message ?? `Gemini error (code: ${msg.error.code ?? 'unknown'})`;
      this.emit('error', new Error(message));
      return;
    }

    if (msg.serverContent) {
      this.handleServerContent(msg.serverContent);
    }

    if (msg.toolCall) {
      void this.handleToolCalls(msg.toolCall.functionCalls);
    }
  }

  private handleServerContent(content: GeminiServerContent): void {
    if (!this.interrupting && content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData) {
          this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
        }
        if (part.text) {
          this.emit('transcript', part.text, 'assistant');
        }
      }
    }

    if (content.turnComplete) {
      this.interrupting = false;
      this.emit('turn_end');
    }
  }

  private async handleToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    const responses = await Promise.all(
      calls.map(async (call, index) => {
        const id = call.id ?? `${call.name}-${index}`;
        this.emit('tool_call', call.name, call.args);

        const tool = this.config.tools?.find((t) => t.name === call.name);
        if (!tool) {
          return {
            id,
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
          id,
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
