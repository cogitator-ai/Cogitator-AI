import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'http';
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
  type Usage,
} from './protocol.js';

export class FastifyStreamWriter {
  private reply: FastifyReply;
  private closed = false;
  private started = false;

  constructor(reply: FastifyReply) {
    this.reply = reply;
  }

  private get writable(): boolean {
    if (this.closed) return false;
    const raw = this.reply.raw;
    if (raw.writableEnded || raw.destroyed) {
      this.closed = true;
      return false;
    }
    return true;
  }

  private write(data: unknown): void {
    if (!this.writable) return;
    this.reply.raw.write(encodeSSE(data));
  }

  private setupHeaders(): void {
    this.started = true;
    if (this.reply.raw.headersSent) return;
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(this.reply.getHeaders())) {
      if (value !== undefined) headers[name] = value;
    }
    this.reply.hijack();
    this.reply.raw.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  start(messageId: string): void {
    if (!this.writable) return;
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
    if (!argsTextDelta) return;
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
    if (!this.writable) return;
    this.write(createFinishEvent(messageId, usage));
    this.reply.raw.write(encodeDone());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.started || this.reply.raw.writableEnded) return;
    try {
      this.reply.raw.end();
    } catch {}
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
