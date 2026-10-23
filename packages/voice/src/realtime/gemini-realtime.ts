import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { RawAudioFormat, RealtimeSessionConfig } from '../types.js';
import { AudioTranscoder } from '../transcoder.js';
import {
  assertRealtimeTools,
  realtimeToolError,
  realtimeToolParts,
  realtimeToolValue,
} from './tool-output.js';

const DEFAULT_MODEL = 'gemini-3.8-live';
const DEFAULT_VOICE = 'Puck';
const BASE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const CONNECT_TIMEOUT_MS = 30_000;
const INPUT_RATE = 16000;
const INPUT_MIME_TYPE = `audio/pcm;rate=${INPUT_RATE}`;
const DEFAULT_OUTPUT_RATE = 24000;
const MULAW_8K: RawAudioFormat = { encoding: 'mulaw', sampleRate: 8000 };

/** The rate of a `audio/pcm;rate=N` MIME type */
function pcmRate(mimeType: string | undefined): number {
  const match = /rate=(\d+)/.exec(mimeType ?? '');
  const rate = match ? Number(match[1]) : NaN;
  return Number.isInteger(rate) && rate > 0 ? rate : DEFAULT_OUTPUT_RATE;
}

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

interface GeminiFunctionResponse {
  id: string;
  name: string;
  response: { result: unknown } | { error: string };
  parts?: Array<{ inlineData: { mimeType: string; data: string } }>;
}

interface GeminiMessage {
  setupComplete?: Record<string, never>;
  serverContent?: GeminiServerContent;
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
  error?: { code?: number; message?: string; status?: string };
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString();
  return data.toString();
}

/**
 * Gemini Live API adapter. Input audio is PCM16 mono at 16kHz, output audio is PCM16 mono at
 * 24kHz. With `audioFormat: 'pcmu'` both are G.711 μ-law at 8 kHz: the adapter decodes and
 * resamples the input to 16 kHz, and resamples and encodes the model's audio.
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
  private calls: AbortController | null = null;
  private readonly runningCalls = new Map<string, AbortController>();
  private readonly inputTranscoder: AudioTranscoder | null;
  private outputTranscoder: AudioTranscoder | null = null;
  private userSpeaking = false;

  constructor(config: RealtimeSessionConfig) {
    super();
    assertRealtimeTools(config.tools);
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL;
    this.inputTranscoder =
      config.audioFormat === 'pcmu'
        ? new AudioTranscoder(MULAW_8K, { encoding: 'pcm16', sampleRate: INPUT_RATE })
        : null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.ws) {
      throw new Error('Already connected or connecting — call close() first');
    }

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

        for (const id of msg.toolCallCancellation?.ids ?? []) {
          this.runningCalls.get(id)?.abort(new Error('Gemini cancelled this tool call'));
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
        this.abortCalls(`Realtime connection closed (code ${code})`);
        settle(new Error(`WebSocket closed before connect (code ${code}): ${reasonStr}`));
        if (wasConnected) this.emit('disconnected', code, reasonStr);
      });
    });
  }

  pushAudio(chunk: Buffer): void {
    const audio = this.inputTranscoder ? this.inputTranscoder.push(chunk) : chunk;
    if (audio.length === 0) return;
    this.send({
      realtimeInput: {
        audio: { mimeType: INPUT_MIME_TYPE, data: audio.toString('base64') },
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
      this.outputTranscoder?.reset();
    }
  }

  /** Gemini keeps no truncatable audio items: it drops an interrupted answer itself */
  truncate(_playedMs: number): void {}

  close(): void {
    const ws = this.ws;
    this.connected = false;
    this.resetTurn();
    this.abortCalls('Realtime session closed');
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
      this.userStartedSpeaking();
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
        this.emitAudio(Buffer.from(part.inlineData.data, 'base64'), part.inlineData.mimeType);
      }
      if (part.text) {
        this.assistantText += part.text;
      }
    }

    if (content.interrupted) {
      this.outputTranscoder?.reset();
      this.flushAssistantTranscript();
      this.modelTurnActive = false;
      this.interrupting = false;
      this.userStartedSpeaking();
    }

    if (content.turnComplete) {
      this.flushOutputAudio();
      this.flushUserTranscript();
      this.flushAssistantTranscript();
      this.modelTurnActive = false;
      this.interrupting = false;
      this.emit('turn_end');
    }
  }

  private emitAudio(audio: Buffer, mimeType: string | undefined): void {
    if (this.config.audioFormat !== 'pcmu') {
      this.emit('audio', audio);
      return;
    }
    const rate = pcmRate(mimeType);
    if (this.outputTranscoder?.from.sampleRate !== rate) {
      this.flushOutputAudio();
      this.outputTranscoder = new AudioTranscoder(
        { encoding: 'pcm16', sampleRate: rate },
        MULAW_8K
      );
    }
    const encoded = this.outputTranscoder.push(audio);
    if (encoded.length > 0) this.emit('audio', encoded);
  }

  /** Emits the end of the model's audio the resampler still holds */
  private flushOutputAudio(): void {
    if (!this.outputTranscoder) return;
    const tail = this.outputTranscoder.flush();
    if (tail.length > 0 && !this.interrupting) this.emit('audio', tail);
  }

  /**
   * `speech_start` once per user turn: on the first transcription of the user's speech, which
   * also comes after the model finished generating while its audio still plays, or on an
   * interruption
   */
  private userStartedSpeaking(): void {
    if (this.userSpeaking) return;
    this.userSpeaking = true;
    this.emit('speech_start');
  }

  private flushUserTranscript(): void {
    this.userSpeaking = false;
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
    this.userSpeaking = false;
    this.outputTranscoder?.reset();
    this.inputTranscoder?.reset();
    this.modelTurnActive = false;
    this.interrupting = false;
    this.userTranscript = '';
    this.assistantTranscript = '';
    this.assistantText = '';
  }

  /**
   * Runs the calls of one `toolCall` message and answers them in one `toolResponse`. A call
   * Gemini cancels (`toolCallCancellation`, sent when the user interrupts) has its signal aborted
   * and gets no answer.
   */
  private async handleToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    const ws = this.ws;
    const session = this.calls?.signal ?? AbortSignal.abort();
    const running = calls.map((call, index) => {
      const cancel = new AbortController();
      if (call.id !== undefined) this.runningCalls.set(call.id, cancel);
      return { call, id: call.id ?? `${call.name}-${index}`, cancel };
    });

    try {
      const responses = await Promise.all(
        running.map(({ call, id, cancel }) =>
          this.executeToolCall(call, id, AbortSignal.any([session, cancel.signal]))
        )
      );
      if (this.ws !== ws) return;
      const functionResponses = responses.filter(
        (_response, index) => !running[index]!.cancel.signal.aborted
      );
      if (functionResponses.length === 0) return;
      this.send({ toolResponse: { functionResponses } });
    } finally {
      for (const { call, cancel } of running) {
        if (call.id !== undefined && this.runningCalls.get(call.id) === cancel) {
          this.runningCalls.delete(call.id);
        }
      }
    }
  }

  private async executeToolCall(
    call: GeminiFunctionCall,
    id: string,
    signal: AbortSignal
  ): Promise<GeminiFunctionResponse> {
    const args = call.args ?? {};
    this.emit('tool_call', call.name, args);

    const tool = this.config.tools?.find((t) => t.name === call.name);
    if (!tool) {
      return { id, name: call.name, response: { error: `Unknown tool: ${call.name}` } };
    }

    try {
      const output = await tool.execute(args, {
        callId: id,
        signal,
        ...(this.config.sessionId !== undefined && { sessionId: this.config.sessionId }),
      });
      const parts = realtimeToolParts(output, tool);
      if (!parts)
        return { id, name: call.name, response: { result: realtimeToolValue(output, tool) } };
      const images = this.config.toolImages ? parts.images : [];
      return {
        id,
        name: call.name,
        response: { result: parts.text },
        ...(images.length > 0 && {
          parts: images.map((image) => ({
            inlineData: { mimeType: image.mediaType, data: image.data },
          })),
        }),
      };
    } catch (err) {
      return { id, name: call.name, response: { error: realtimeToolError(err, tool) } };
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
