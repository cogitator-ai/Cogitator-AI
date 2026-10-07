import type { SSEStreamingApi } from 'hono/streaming';
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
  createWorkflowEvent,
  createSwarmEvent,
  encodeHeartbeat,
  resolveSseHeartbeatMs,
  startHeartbeat,
  type PendingApproval,
  type StreamEvent,
  type Usage,
} from '@cogitator-ai/server-shared';

export interface HonoStreamWriterOptions {
  /**
   * How often an SSE comment is written while the stream is open, in milliseconds,
   * so a run waiting on a slow tool or model is not cut off by an idle timeout
   * (`Bun.serve` closes a connection silent for 10 s, proxies one silent for 60 s).
   * Default: 5000. `0` turns it off.
   */
  heartbeatMs?: number;
}

export class HonoStreamWriter {
  private stream: SSEStreamingApi;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly stopHeartbeat: () => void;

  constructor(stream: SSEStreamingApi, options: HonoStreamWriterOptions = {}) {
    this.stream = stream;
    this.stopHeartbeat = startHeartbeat(
      () => this.heartbeat(),
      resolveSseHeartbeatMs(options.heartbeatMs)
    );
  }

  private heartbeat(): boolean {
    if (this.closed || this.stream.closed || this.stream.aborted) return false;
    this.stream.write(encodeHeartbeat()).catch(() => this.close());
    return true;
  }

  private async write(data: unknown): Promise<void> {
    if (this.closed) return;
    await this.stream.writeSSE({
      data: JSON.stringify(data),
    });
  }

  /**
   * Sends one protocol event; `finish`, the last one, is followed by `data: [DONE]`. Events
   * are written in the order they were sent, also when nobody awaits them, so a run's
   * callbacks can send without waiting. `flush()` waits for every event sent so far.
   */
  send(event: StreamEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    const written = this.queue.then(async () => {
      await this.stream.writeSSE({ data: JSON.stringify(event) });
      if (event.type === 'finish') await this.stream.writeSSE({ data: '[DONE]' });
    });
    this.queue = written.catch(() => undefined);
    return written;
  }

  /** Resolves once every event sent so far is written */
  flush(): Promise<void> {
    return this.queue;
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
    if (!argsTextDelta) return;
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

  async workflowEvent(event: string, data: unknown): Promise<void> {
    await this.write(createWorkflowEvent(event, data));
  }

  async swarmEvent(event: string, data: unknown): Promise<void> {
    await this.write(createSwarmEvent(event, data));
  }

  async error(message: string, code?: string): Promise<void> {
    await this.write(createErrorEvent(message, code));
  }

  async finish(messageId: string, usage?: Usage): Promise<void> {
    await this.send(createFinishEvent(messageId, usage));
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
