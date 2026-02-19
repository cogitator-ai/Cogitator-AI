import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { z } from 'zod';
import type {
  AgentCard,
  A2AMessage,
  A2ATask,
  A2AStreamEvent,
  A2AClientConfig,
  SendMessageConfiguration,
} from './types.js';
import { isTerminalState } from './types.js';
import type { JsonRpcResponse } from './json-rpc.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';

export interface A2AToolOptions {
  name?: string;
  description?: string;
  timeout?: number;
}

export interface A2AToolResult {
  output: string;
  success: boolean;
  error?: string;
}

export class A2AClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private agentCardPath: string;
  private rpcPath: string;
  private cachedCard: AgentCard | null = null;

  constructor(baseUrl: string, config?: A2AClientConfig) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = config?.headers ?? {};
    this.timeout = config?.timeout ?? 30000;
    this.agentCardPath = config?.agentCardPath ?? '/.well-known/agent.json';
    this.rpcPath = config?.rpcPath ?? '/a2a';
  }

  async agentCard(): Promise<AgentCard> {
    if (this.cachedCard) return this.cachedCard;

    const response = await this.httpGet(this.agentCardPath);
    const data = await response.json();
    this.cachedCard = Array.isArray(data) ? data[0] : data;
    return this.cachedCard!;
  }

  async sendMessage(message: A2AMessage, config?: SendMessageConfiguration): Promise<A2ATask> {
    const result = await this.rpc('message/send', {
      message,
      configuration: config,
    });
    return result as A2ATask;
  }

  async *sendMessageStream(
    message: A2AMessage,
    config?: SendMessageConfiguration
  ): AsyncGenerator<A2AStreamEvent> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/stream',
      params: { message, configuration: config },
      id: this.generateRequestId(),
    });

    const response = await fetch(`${this.baseUrl}${this.rpcPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.headers,
      },
      body,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new A2AError(errors.internalError(`HTTP ${response.status}: ${response.statusText}`));
    }

    if (!response.body) return;

    yield* this.parseSSEStream(response.body);
  }

  async getTask(taskId: string, historyLength?: number): Promise<A2ATask> {
    const result = await this.rpc('tasks/get', { id: taskId, historyLength });
    return result as A2ATask;
  }

  async cancelTask(taskId: string): Promise<A2ATask> {
    const result = await this.rpc('tasks/cancel', { id: taskId });
    return result as A2ATask;
  }

  asTool(options?: A2AToolOptions): Tool<{ task: string }, A2AToolResult> {
    const toolName = options?.name ?? 'a2a_remote_agent';
    const toolDescription = options?.description ?? 'Remote A2A agent';
    const toolTimeout = options?.timeout ?? this.timeout;

    const parameters = z.object({
      task: z.string().describe('The task to send to the remote agent'),
    });

    return {
      name: toolName,
      description: toolDescription,
      parameters,
      timeout: toolTimeout,
      sideEffects: ['external'],

      execute: async (params: { task: string }, _context: ToolContext): Promise<A2AToolResult> => {
        try {
          const message: A2AMessage = {
            role: 'user',
            parts: [{ type: 'text', text: params.task }],
          };

          const task = await this.sendMessage(message);

          if (task.status.state === 'completed') {
            const output = this.extractOutputFromTask(task);
            return { output, success: true };
          }

          if (task.status.state === 'failed') {
            return {
              output: '',
              success: false,
              error: task.status.message ?? 'Task failed',
            };
          }

          return {
            output: '',
            success: false,
            error: `Unexpected task state: ${task.status.state}`,
          };
        } catch (error) {
          return {
            output: '',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },

      toJSON(): ToolSchema {
        return {
          name: toolName,
          description: toolDescription,
          parameters: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The task to send to the remote agent' },
            },
            required: ['task'],
          },
        };
      },
    };
  }

  asToolFromCard(card: AgentCard, options?: A2AToolOptions): Tool<{ task: string }, A2AToolResult> {
    return this.asTool({
      name: options?.name ?? card.name,
      description: options?.description ?? card.description ?? `Remote A2A agent: ${card.name}`,
      timeout: options?.timeout,
    });
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: this.generateRequestId(),
    });

    const response = await fetch(`${this.baseUrl}${this.rpcPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new A2AError(errors.internalError(`HTTP ${response.status}: ${response.statusText}`));
    }

    const json = (await response.json()) as JsonRpcResponse;

    if (json.error) {
      throw new A2AError(json.error);
    }

    return json.result;
  }

  private async httpGet(path: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new A2AError(errors.internalError(`HTTP ${response.status}: ${response.statusText}`));
    }

    return response;
  }

  private async *parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<A2AStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim()) continue;

          const lines = frame.split('\n');
          let data = '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              data += line.slice(6);
            }
          }

          if (!data || data === '[DONE]') continue;

          try {
            const event = JSON.parse(data) as A2AStreamEvent;
            yield event;

            if (event.type === 'status-update' && isTerminalState(event.status.state)) {
              return;
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private extractOutputFromTask(task: A2ATask): string {
    for (const artifact of task.artifacts) {
      for (const part of artifact.parts) {
        if (part.type === 'text') return part.text;
      }
    }

    for (let i = task.history.length - 1; i >= 0; i--) {
      const msg = task.history[i];
      if (msg.role === 'agent') {
        for (const part of msg.parts) {
          if (part.type === 'text') return part.text;
        }
      }
    }

    return '';
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
