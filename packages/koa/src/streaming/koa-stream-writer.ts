import type { Context } from 'koa';
import type { ServerResponse } from 'http';
import {
  encodeSSE,
  encodeDone,
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
  createWorkflowEvent,
  createSwarmEvent,
  type Usage,
} from '@cogitator-ai/server-shared';

export class KoaStreamWriter {
  private res: ServerResponse;
  private closed = false;

  constructor(ctx: Context) {
    this.res = ctx.res;
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
