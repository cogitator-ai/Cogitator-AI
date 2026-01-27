import type { SSEStreamingApi } from 'hono/streaming';
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
} from '@cogitator-ai/server-shared';

export class HonoStreamWriter {
  private stream: SSEStreamingApi;
  private closed = false;

  constructor(stream: SSEStreamingApi) {
    this.stream = stream;
  }

  private async write(data: unknown): Promise<void> {
    if (this.closed) return;
    await this.stream.writeSSE({
      data: JSON.stringify(data),
      event: 'message',
    });
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
    await this.write(createFinishEvent(messageId, usage));
    await this.stream.writeSSE({ data: '[DONE]', event: 'message' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
