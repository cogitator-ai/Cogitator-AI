import type { Context } from 'koa';
import type { ServerResponse } from 'http';
import {
  encodeSSE,
  encodeDone,
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
  type Usage,
} from '@cogitator-ai/server-shared';

export interface KoaStreamWriterOptions {
  /**
   * How often an SSE comment is written while the stream is open, in milliseconds,
   * so proxies and load balancers do not close a stream that waits on a slow tool or
   * model. Default: 5000. `0` turns it off.
   */
  heartbeatMs?: number;
}

export class KoaStreamWriter {
  private res: ServerResponse;
  private closed = false;
  private readonly stopHeartbeat: () => void;

  constructor(ctx: Context, options: KoaStreamWriterOptions = {}) {
    this.res = ctx.res;
    this.stopHeartbeat = startHeartbeat(
      () => this.heartbeat(),
      resolveSseHeartbeatMs(options.heartbeatMs)
    );
  }

  private get writable(): boolean {
    return !this.closed && !this.res.writableEnded && !this.res.destroyed;
  }

  private heartbeat(): boolean {
    if (!this.writable) return false;
    this.res.write(encodeHeartbeat());
    return true;
  }

  private write(data: unknown): void {
    if (this.closed) return;
    this.res.write(encodeSSE(data));
  }

  start(messageId: string): void {
    this.write(createStartEvent(messageId));
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
    if (this.closed) return;
    this.write(createFinishEvent(messageId, usage));
    this.res.write(encodeDone());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.res.end();
    } catch {}
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export function setupSSEHeaders(ctx: Context): void {
  ctx.status = 200;
  ctx.set('Content-Type', 'text/event-stream');
  ctx.set('Cache-Control', 'no-cache');
  ctx.set('Connection', 'keep-alive');
  ctx.set('X-Accel-Buffering', 'no');
  ctx.respond = false;
  ctx.res.flushHeaders();
}
