import { encodeSSE, encodeDone } from './encoder.js';
import {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createErrorEvent,
  createFinishEvent,
  type Usage,
} from './protocol.js';

export class StreamWriter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.writer = writer;
  }

  private async write(data: unknown): Promise<void> {
    if (this.closed) return;
    await this.writer.write(encodeSSE(data));
  }

  async start(messageId: string): Promise<void> {
    await this.write(createStartEvent(messageId));
  }

  async textStart(id: string): Promise<void> {
    await this.write(createTextStartEvent(id));
  }

  async textDelta(id: string, delta: string): Promise<void> {
    if (!delta) return;
    await this.write(createTextDeltaEvent(id, delta));
  }

  async textEnd(id: string): Promise<void> {
    await this.write(createTextEndEvent(id));
  }

  async toolCallStart(id: string, toolName: string): Promise<void> {
    await this.write(createToolCallStartEvent(id, toolName));
  }

  async toolCallDelta(id: string, argsTextDelta: string): Promise<void> {
    await this.write(createToolCallDeltaEvent(id, argsTextDelta));
  }

  async toolCallEnd(id: string): Promise<void> {
    await this.write(createToolCallEndEvent(id));
  }

  async toolResult(id: string, toolCallId: string, result: unknown): Promise<void> {
    await this.write(createToolResultEvent(id, toolCallId, result));
  }

  async error(message: string, code?: string): Promise<void> {
    await this.write(createErrorEvent(message, code));
  }

  async finish(messageId: string, usage?: Usage): Promise<void> {
    await this.write(createFinishEvent(messageId, usage));
    await this.writer.write(encodeDone());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {}
  }
}
