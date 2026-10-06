import type { Response } from 'express';
import {
  encodeHeartbeat,
  resolveSseHeartbeatMs,
  startHeartbeat,
} from '@cogitator-ai/server-shared';
import { encodeSSE, encodeDone } from './helpers.js';
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
  type PendingApproval,
  type StreamEvent,
  type Usage,
} from './protocol.js';

export interface ExpressStreamWriterOptions {
  /**
   * How often an SSE comment is written while the stream is open, in milliseconds,
   * so proxies and load balancers do not close a stream that waits on a slow tool or
   * model. Default: 5000. `0` turns it off.
   */
  heartbeatMs?: number;
}

export class ExpressStreamWriter {
  private res: Response;
  private closed = false;
  private readonly stopHeartbeat: () => void;

  constructor(res: Response, options: ExpressStreamWriterOptions = {}) {
    this.res = res;
    this.stopHeartbeat = startHeartbeat(
      () => this.heartbeat(),
      resolveSseHeartbeatMs(options.heartbeatMs)
    );
  }

  private heartbeat(): boolean {
    if (!this.writable) return false;
    this.res.write(encodeHeartbeat());
    return true;
  }

  private get writable(): boolean {
    if (this.closed) return false;
    if (this.res.writableEnded || this.res.destroyed) {
      this.closed = true;
      return false;
    }
    return true;
  }

  private write(data: unknown): void {
    if (!this.writable) return;
    this.res.write(encodeSSE(data));
  }

  /** Sends one protocol event; `finish`, the last one, is followed by `data: [DONE]` */
  send(event: StreamEvent): void {
    if (!this.writable) return;
    this.write(event);
    if (event.type === 'finish') this.res.write(encodeDone());
  }

  start(messageId: string, threadId?: string): void {
    this.write(createStartEvent(messageId, threadId));
  }

  textStart(id: string): void {
    this.write(createTextStartEvent(id));
  }

  textDelta(id: string, delta: string): void {
    if (!delta) return;
    this.write(createTextDeltaEvent(id, delta));
  }

  textEnd(id: string): void {
    this.write(createTextEndEvent(id));
  }

  reasoningStart(id: string): void {
    this.write(createReasoningStartEvent(id));
  }

  reasoningDelta(id: string, delta: string): void {
    if (!delta) return;
    this.write(createReasoningDeltaEvent(id, delta));
  }

  reasoningEnd(id: string): void {
    this.write(createReasoningEndEvent(id));
  }

  toolCallStart(id: string, toolName: string): void {
    this.write(createToolCallStartEvent(id, toolName));
  }

  toolCallDelta(id: string, argsTextDelta: string): void {
    this.write(createToolCallDeltaEvent(id, argsTextDelta));
  }

  toolCallEnd(id: string): void {
    this.write(createToolCallEndEvent(id));
  }

  toolResult(id: string, toolCallId: string, result: unknown): void {
    this.write(createToolResultEvent(id, toolCallId, result));
  }

  approvalRequired(threadId: string, approvals: readonly PendingApproval[]): void {
    this.write(createApprovalRequiredEvent(threadId, approvals));
  }

  workflowEvent(event: string, data: unknown): void {
    this.write(createWorkflowEvent(event, data));
  }

  swarmEvent(event: string, data: unknown): void {
    this.write(createSwarmEvent(event, data));
  }

  error(message: string, code?: string): void {
    this.write(createErrorEvent(message, code));
  }

  finish(messageId: string, usage?: Usage): void {
    this.send(createFinishEvent(messageId, usage));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    if (this.res.writableEnded) return;
    try {
      this.res.end();
    } catch {}
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export function setupSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}
