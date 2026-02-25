import type { FastifyReply } from 'fastify';
import { encodeSSE, encodeDone } from './helpers.js';
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
  createWorkflowEvent,
  createSwarmEvent,
  type Usage,
} from './protocol.js';

export class FastifyStreamWriter {
  private reply: FastifyReply;
  private closed = false;

  constructor(reply: FastifyReply) {
    this.reply = reply;
  }

  private write(data: unknown): void {
    if (this.closed) return;
    this.reply.raw.write(encodeSSE(data));
  }

  private setupHeaders(): void {
    this.reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  start(messageId: string): void {
    this.setupHeaders();
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
    if (!argsTextDelta) return;
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
    this.reply.raw.write(encodeDone());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.reply.raw.end();
    } catch {}
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
