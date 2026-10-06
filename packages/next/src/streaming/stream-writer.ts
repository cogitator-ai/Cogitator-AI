import {
  encodeHeartbeat,
  resolveSseHeartbeatMs,
  startHeartbeat,
} from '@cogitator-ai/server-shared';
import { encodeSSE, encodeDone } from './encoder.js';
import {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createReasoningStartEvent,
  createReasoningDeltaEvent,
  createReasoningEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createApprovalRequiredEvent,
  createErrorEvent,
  createFinishEvent,
  type PendingApproval,
  type StreamEvent,
  type Usage,
} from './protocol.js';

export interface StreamWriterOptions {
  /**
   * How often an SSE comment is written while the stream is open, in milliseconds, so a
   * proxy or the platform's idle timeout does not close a stream that waits on a slow tool
   * or model. Default: 5000. `0` turns it off.
   */
  heartbeatMs?: number;
}

const heartbeatFrame = new TextEncoder().encode(encodeHeartbeat());

export class StreamWriter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;
  private readonly stopHeartbeat: () => void;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>, options: StreamWriterOptions = {}) {
    this.writer = writer;
    this.stopHeartbeat = startHeartbeat(
      () => this.heartbeat(),
      resolveSseHeartbeatMs(options.heartbeatMs)
    );
  }

  private heartbeat(): boolean {
    if (this.closed) return false;
    this.writer.write(heartbeatFrame).catch(() => {
      this.closed = true;
    });
    return true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async write(data: unknown): Promise<void> {
    if (this.closed) return;
    try {
      await this.writer.write(encodeSSE(data));
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }

  /** Sends one protocol event; `finish`, the last one, is followed by `data: [DONE]` */
  async send(event: StreamEvent): Promise<void> {
    if (this.closed) return;
    await this.write(event);
    if (event.type !== 'finish' || this.closed) return;
    try {
      await this.writer.write(encodeDone());
    } catch {
      this.closed = true;
    }
  }

  async start(messageId: string, threadId?: string): Promise<void> {
    await this.write(createStartEvent(messageId, threadId));
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

  async reasoningStart(id: string): Promise<void> {
    await this.write(createReasoningStartEvent(id));
  }

  async reasoningDelta(id: string, delta: string): Promise<void> {
    if (!delta) return;
    await this.write(createReasoningDeltaEvent(id, delta));
  }

  async reasoningEnd(id: string): Promise<void> {
    await this.write(createReasoningEndEvent(id));
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

  async approvalRequired(threadId: string, approvals: readonly PendingApproval[]): Promise<void> {
    await this.write(createApprovalRequiredEvent(threadId, approvals));
  }

  async error(message: string, code?: string): Promise<void> {
    await this.write(createErrorEvent(message, code));
  }

  async finish(messageId: string, usage?: Usage, threadId?: string): Promise<void> {
    await this.send(
      createFinishEvent(messageId, usage, threadId === undefined ? {} : { threadId })
    );
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {}
  }
}
