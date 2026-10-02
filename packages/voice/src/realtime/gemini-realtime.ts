import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { RealtimeSessionConfig } from '../types.js';

const DEFAULT_MODEL = 'gemini-3.8-live';
const DEFAULT_VOICE = 'Puck';
const BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const CONNECT_TIMEOUT_MS = 30_000;
const INPUT_MIME_TYPE = 'audio/pcm;rate=16000';

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

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiServerContent {
  modelTurn?: { parts?: GeminiPart[] };
  inputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
  interrupted?: boolean;
  turnComplete?: boolean;
}

interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiMessage {
  setupComplete?: Record<string, never>;
  serverContent?: GeminiServerContent;
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  error?: { code?: number; message?: string; status?: string };
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();
  return data.toString();
}

/**
 * Gemini Live API adapter. Input audio is PCM16 mono at 16kHz,
 * output audio is PCM16 mono at 24kHz.
 */
export class GeminiRealtimeAdapter extends EventEmitter<GeminiRealtimeEvents> {
  private readonly config: RealtimeSessionConfig;
  private readonly model: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private modelTurnActive = false;
  private interrupting = false;
  private userTranscript = '';
  private assistantTranscript = '';
  private assistantText = '';

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

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      const ws = new WebSocket(BASE_URL, {
        headers: { 'x-goog-api-key': this.config.apiKey },
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
        this.sendSetup();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        let msg: GeminiMessage;
        try {
          msg = JSON.parse(rawDataToString(data)) as GeminiMessage;
        } catch {
          this.emit('error', new Error('Failed to parse WebSocket message'));
          return;
        }

        if (msg.error) {
          const err = new Error(
            msg.error.message ?? `Gemini error (code: ${msg.error.code ?? 'unknown'})`
          );
          if (settled) this.emit('error', err);
          else settle(err);
          return;
        }

        if (msg.setupComplete) {
          this.connected = true;
          this.emit('connected');
          settle();
          return;
        }

        if (msg.serverContent) {
          this.handleServerContent(msg.serverContent);
        }

        if (msg.toolCall?.functionCalls?.length) {
          void this.handleToolCalls(msg.toolCall.functionCalls);
        }
      });

      ws.on('error', (err: Error) => {
        if (settled) this.emit('error', err);
        else settle(err);
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || 'connection closed';
        if (this.ws === ws) this.ws = null;
        const wasConnected = this.connected;
        this.resetTurn();
        this.connected = false;
        settle(new Error(`WebSocket closed before connect (code ${code}): ${reasonStr}`));
        if (wasConnected) this.emit('disconnected', code, reasonStr);
      });
    });
  }

  pushAudio(chunk: Buffer): void {
    this.send({
      realtimeInput: {
        audio: { mimeType: INPUT_MIME_TYPE, data: chunk.toString('base64') },
      },
    });
  }

  sendText(text: string): void {
    this.send({ realtimeInput: { text } });
  }

  /**
   * Gemini Live barge-in is driven by incoming user audio, not a control message.
   * While a model turn is in progress this drops the remaining model audio until
   * the turn completes, simulating an interruption on the consumer side.
   */
  interrupt(): void {
    if (this.modelTurnActive) {
      this.interrupting = true;
    }
  }

  close(): void {
    const ws = this.ws;
    this.connected = false;
    this.resetTurn();
    if (!ws) return;
    this.ws = null;
    ws.removeAllListeners();
    ws.on('error', () => {});
    ws.close();
  }

  private sendSetup(): void {
    const setup: Record<string, unknown> = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.config.voice ?? DEFAULT_VOICE },
          },
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (this.config.instructions) {
      setup.systemInstruction = { parts: [{ text: this.config.instructions }] };
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

  private handleServerContent(content: GeminiServerContent): void {
    const inputText = content.inputTranscription?.text;
    if (inputText) {
      this.userTranscript += inputText;
    }

    const outputText = content.outputTranscription?.text;
    const parts = content.modelTurn?.parts ?? [];
    if (parts.length > 0 || outputText) {
      this.modelTurnActive = true;
      this.flushUserTranscript();
    }

    if (outputText) {
      this.assistantTranscript += outputText;
    }

    for (const part of parts) {
      if (part.thought) continue;
      if (part.inlineData?.data && !this.interrupting) {
        this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
      }
      if (part.text) {
        this.assistantText += part.text;
      }
    }

    if (content.interrupted) {
      this.flushAssistantTranscript();
      this.modelTurnActive = false;
      this.interrupting = false;
      this.emit('speech_start');
    }

    if (content.turnComplete) {
      this.flushUserTranscript();
      this.flushAssistantTranscript();
      this.modelTurnActive = false;
      this.interrupting = false;
      this.emit('turn_end');
    }
  }

  private flushUserTranscript(): void {
    const text = this.userTranscript.trim();
    this.userTranscript = '';
    if (text) this.emit('transcript', text, 'user');
  }

  private flushAssistantTranscript(): void {
    const text = (this.assistantTranscript || this.assistantText).trim();
    this.assistantTranscript = '';
    this.assistantText = '';
    if (text) this.emit('transcript', text, 'assistant');
  }

  private resetTurn(): void {
    this.modelTurnActive = false;
    this.interrupting = false;
    this.userTranscript = '';
    this.assistantTranscript = '';
    this.assistantText = '';
  }

  private async handleToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    const ws = this.ws;
    const functionResponses = await Promise.all(
      calls.map(async (call, index) => {
        const id = call.id ?? `${call.name}-${index}`;
        const args = call.args ?? {};
        this.emit('tool_call', call.name, args);

        const tool = this.config.tools?.find((t) => t.name === call.name);
        if (!tool) {
          return { id, name: call.name, response: { error: `Unknown tool: ${call.name}` } };
        }

        try {
          const output = await tool.execute(args);
          return { id, name: call.name, response: { result: output ?? null } };
        } catch (err) {
          return {
            id,
            name: call.name,
            response: { error: err instanceof Error ? err.message : String(err) },
          };
        }
      })
    );

    if (this.ws !== ws) return;
    this.send({ toolResponse: { functionResponses } });
  }

  private send(data: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
