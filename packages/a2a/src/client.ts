import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentCard,
  ExtendedAgentCard,
  A2AMessage,
  A2ATask,
  A2AStreamEvent,
  A2AClientConfig,
  SendMessageConfiguration,
  TaskFilter,
  PushNotificationConfig,
  TaskState,
} from './types.js';
import { isStreamFinalState } from './types.js';
import type { JsonRpcResponse } from './json-rpc.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { verifyAgentCardSignature } from './agent-card.js';

export interface A2AToolOptions {
  name?: string;
  description?: string;
  timeout?: number;
}

export interface A2AToolResult {
  output: string;
  success: boolean;
  error?: string;
  /** Remote task id, set when the task needs follow-up (e.g. input-required) */
  taskId?: string;
  /** Final state of the remote task */
  state?: TaskState;
}

export interface A2ARequestOptions {
  /** Cancels the request (and an in-flight stream) */
  signal?: AbortSignal;
  /** Overrides the client timeout for this request; for streams it is the idle timeout between events */
  timeout?: number;
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

export class A2AClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private agentCardPath: string;
  private rpcPath: string;
  private agentName?: string;
  private cachedCard: AgentCard | null = null;

  constructor(baseUrl: string, config?: A2AClientConfig) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.headers = config?.headers ?? {};
    this.timeout = config?.timeout ?? 30000;
    this.agentCardPath = config?.agentCardPath ?? '/.well-known/agent.json';
    this.rpcPath = config?.rpcPath ?? '/a2a';
    this.agentName = config?.agentName;
  }

  async agentCard(): Promise<AgentCard> {
    if (this.cachedCard) return this.cachedCard;

    const response = await this.httpGet(this.agentCardPath);
    const data = (await response.json()) as AgentCard | AgentCard[];
    const cards = Array.isArray(data) ? data : [data];
    if (cards.length === 0) {
      throw new A2AError(errors.internalError('Agent card response is empty array'));
    }
    const card = this.agentName
      ? cards.find((candidate) => candidate.name === this.agentName)
      : cards[0];
    if (!card) {
      throw new A2AError(errors.agentNotFound(this.agentName ?? ''));
    }
    this.cachedCard = card;
    return card;
  }

  async refreshAgentCard(): Promise<AgentCard> {
    this.cachedCard = null;
    return this.agentCard();
  }

  async sendMessage(
    message: A2AMessage,
    config?: SendMessageConfiguration,
    options?: A2ARequestOptions
  ): Promise<A2ATask> {
    const result = await this.rpc(
      'message/send',
      this.withAgent({ message, configuration: config }),
      options
    );
    return result as A2ATask;
  }

  /**
   * Stream a message. The client timeout applies to the wait for the response
   * and to the idle time between events, not to the total stream duration.
   */
  async *sendMessageStream(
    message: A2AMessage,
    config?: SendMessageConfiguration,
    options?: A2ARequestOptions
  ): AsyncGenerator<A2AStreamEvent> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/stream',
      params: this.withAgent({ message, configuration: config }),
      id: this.generateRequestId(),
    });

    const idleTimeout = options?.timeout ?? this.timeout;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('A2A stream timed out', 'TimeoutError'));
      }, idleTimeout);
    };
    const onExternalAbort = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) onExternalAbort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      armTimer();
      const response = await fetch(`${this.baseUrl}${this.rpcPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.headers,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.throwHttpError(response);
      }

      if (!response.body) return;

      yield* this.parseSSEStream(response.body, armTimer);
    } catch (error) {
      if (timedOut) {
        throw new A2AError(errors.internalError(`Stream idle for more than ${idleTimeout}ms`));
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onExternalAbort);
      controller.abort();
    }
  }

  async getTask(taskId: string, historyLength?: number): Promise<A2ATask> {
    const result = await this.rpc(
      'tasks/get',
      historyLength === undefined ? { id: taskId } : { id: taskId, historyLength }
    );
    return result as A2ATask;
  }

  async cancelTask(taskId: string): Promise<A2ATask> {
    const result = await this.rpc('tasks/cancel', { id: taskId });
    return result as A2ATask;
  }

  async continueTask(
    taskId: string,
    text: string,
    config?: SendMessageConfiguration,
    options?: A2ARequestOptions
  ): Promise<A2ATask> {
    return this.sendMessage(
      {
        role: 'user',
        parts: [{ type: 'text', text }],
        taskId,
      },
      config,
      options
    );
  }

  async listTasks(filter?: TaskFilter): Promise<A2ATask[]> {
    const result = (await this.rpc('tasks/list', filter ?? {})) as { tasks: A2ATask[] };
    return result.tasks;
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

      execute: async (params: { task: string }, context: ToolContext): Promise<A2AToolResult> => {
        try {
          const message: A2AMessage = {
            role: 'user',
            parts: [{ type: 'text', text: params.task }],
          };

          const task = await this.sendMessage(message, undefined, {
            signal: context?.signal,
            timeout: toolTimeout,
          });
          const state = task.status.state;
          const output = this.extractOutputFromTask(task);

          if (state === 'completed') {
            return { output, success: true, state };
          }

          if (state === 'input-required') {
            return {
              output,
              success: false,
              error: 'Remote agent requires more input to continue this task',
              taskId: task.id,
              state,
            };
          }

          return {
            output,
            success: false,
            error: task.status.message ?? `Remote task ended in state: ${state}`,
            taskId: task.id,
            state,
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

  async createPushNotification(
    taskId: string,
    config: PushNotificationConfig
  ): Promise<PushNotificationConfig> {
    const result = await this.rpc('tasks/pushNotification/create', { taskId, config });
    return result as PushNotificationConfig;
  }

  async getPushNotification(
    taskId: string,
    configId: string
  ): Promise<PushNotificationConfig | null> {
    const result = await this.rpc('tasks/pushNotification/get', { taskId, configId });
    return result as PushNotificationConfig | null;
  }

  async listPushNotifications(taskId: string): Promise<PushNotificationConfig[]> {
    const result = await this.rpc('tasks/pushNotification/list', { taskId });
    return result as PushNotificationConfig[];
  }

  async deletePushNotification(taskId: string, configId: string): Promise<void> {
    await this.rpc('tasks/pushNotification/delete', { taskId, configId });
  }

  async verifyAgentCard(secret: string): Promise<boolean> {
    const card = await this.agentCard();
    return verifyAgentCardSignature(card as AgentCard & { signature?: string }, secret);
  }

  async extendedAgentCard(): Promise<ExtendedAgentCard> {
    const result = await this.rpc('agent/extendedCard', this.withAgent({}));
    return result as ExtendedAgentCard;
  }

  asToolFromCard(card: AgentCard, options?: A2AToolOptions): Tool<{ task: string }, A2AToolResult> {
    return this.asTool({
      name: options?.name ?? card.name,
      description: options?.description ?? card.description ?? `Remote A2A agent: ${card.name}`,
      timeout: options?.timeout,
    });
  }

  private async rpc(
    method: string,
    params: unknown,
    options?: A2ARequestOptions
  ): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: this.generateRequestId(),
    });

    const timeoutSignal = AbortSignal.timeout(options?.timeout ?? this.timeout);
    const response = await fetch(`${this.baseUrl}${this.rpcPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
      signal: options?.signal ? combineSignals(options.signal, timeoutSignal) : timeoutSignal,
    });

    if (!response.ok) {
      await this.throwHttpError(response);
    }

    const json = (await response.json()) as JsonRpcResponse;

    if (json.error) {
      throw new A2AError(json.error);
    }

    return json.result;
  }

  /**
   * Surface a JSON-RPC error body when the server sent one with a non-2xx status
   */
  private async throwHttpError(response: Response): Promise<never> {
    const text = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(text) as Partial<JsonRpcResponse>;
      if (parsed.error && typeof parsed.error.code === 'number') {
        throw new A2AError(parsed.error);
      }
    } catch (error) {
      if (error instanceof A2AError) throw error;
    }
    throw new A2AError(errors.internalError(`HTTP ${response.status}: ${response.statusText}`));
  }

  private async httpGet(path: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      await this.throwHttpError(response);
    }

    return response;
  }

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    onActivity?: () => void
  ): AsyncGenerator<A2AStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onActivity?.();

        buffer += decoder.decode(value, { stream: true });
        const pendingCarriageReturn = buffer.endsWith('\r');
        const normalized = (pendingCarriageReturn ? buffer.slice(0, -1) : buffer).replace(
          /\r\n?/g,
          '\n'
        );

        const frames = normalized.split('\n\n');
        buffer = (frames.pop() ?? '') + (pendingCarriageReturn ? '\r' : '');

        for (const frame of frames) {
          const data = this.extractSseData(frame);
          if (!data || data === '[DONE]') continue;

          let event: A2AStreamEvent;
          try {
            event = JSON.parse(data) as A2AStreamEvent;
          } catch {
            process.stderr.write(`[a2a] Failed to parse SSE event: ${data.slice(0, 200)}\n`);
            continue;
          }

          yield event;

          if (event.type === 'status-update' && isStreamFinalState(event.status.state)) {
            return;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private extractSseData(frame: string): string {
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      }
    }
    return dataLines.join('\n');
  }

  private extractOutputFromTask(task: A2ATask): string {
    const history = task.history ?? [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === 'agent') {
        const text = msg.parts.find((part) => part.type === 'text');
        if (text) return text.text;
      }
    }

    const artifacts = task.artifacts ?? [];
    for (let i = artifacts.length - 1; i >= 0; i--) {
      const text = artifacts[i].parts.find((part) => part.type === 'text');
      if (text) return text.text;
    }

    return task.status.message ?? '';
  }

  private withAgent<T extends object>(params: T): T & { agentName?: string } {
    return this.agentName === undefined ? params : { ...params, agentName: this.agentName };
  }

  private generateRequestId(): string {
    return `req_${randomUUID()}`;
  }
}
