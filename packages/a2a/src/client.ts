import type { Tool, ToolApprovalRequest, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentCard,
  A2AMessageInput,
  A2ATask,
  A2AStreamEvent,
  A2AClientConfig,
  MessageSendConfiguration,
  PushNotificationConfig,
  SendMessageResult,
  TaskFilter,
  TaskPushNotificationConfig,
  TaskState,
} from './types.js';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH } from './types.js';
import type { JsonRpcResponse } from './json-rpc.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { verifyAgentCardSignature } from './agent-card.js';
import {
  readToolApprovalRequest,
  toolApprovalResponsePart,
  type ToolApprovalResponse,
} from './approvals.js';
import { artifactText, messageText, textPart, toMessage } from './protocol.js';
import { trimTrailingSlashes } from './url.js';

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
  /**
   * The tool calls the remote agent waits on, when the task is `input-required` for approvals:
   * answer with `answerApprovals` (or a `toolApprovalResponsePart` in a message that continues `taskId`)
   */
  pendingApprovals?: ToolApprovalRequest[];
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

function isFinalEvent(event: A2AStreamEvent): boolean {
  return event.kind === 'message' || (event.kind === 'status-update' && event.final);
}

/**
 * The text a task answered with: its status message, else the last agent message, else the text
 * of its artifacts.
 */
function taskOutput(task: A2ATask): string {
  const status = messageText(task.status.message);
  if (status) return status;
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'agent') {
      const text = messageText(history[i]);
      if (text) return text;
    }
  }
  return (task.artifacts ?? []).map(artifactText).filter(Boolean).join('\n');
}

/**
 * A2A v0.3 client over JSON-RPC. It reads the Agent Card at the base URL and sends requests to
 * the endpoint the card names, so it talks to any A2A v0.3 server.
 */
export class A2AClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private agentCardPath?: string;
  private rpcPath?: string;
  private agentName?: string;
  private cachedCard: AgentCard | null = null;
  private cachedCardUrl: string | null = null;

  constructor(baseUrl: string, config?: A2AClientConfig) {
    this.baseUrl = trimTrailingSlashes(baseUrl);
    this.headers = config?.headers ?? {};
    this.timeout = config?.timeout ?? 30000;
    this.agentCardPath = config?.agentCardPath;
    this.rpcPath = config?.rpcPath;
    this.agentName = config?.agentName;
  }

  /**
   * The Agent Card: from `/.well-known/agent-card.json` at the base URL (or the pre-v0.3
   * `/.well-known/agent.json` when the server has no v0.3 card), or `agentCardPath`. With
   * `agentName` it is the card of that agent on a Cogitator server hosting several.
   */
  async agentCard(): Promise<AgentCard> {
    if (this.cachedCard) return this.cachedCard;

    const { card, url } = await this.fetchDefaultCard();
    if (!this.agentName || card.name === this.agentName) {
      return this.cacheCard(card, url);
    }

    const agentUrl = `${this.resolveUrl(card.url, url).replace(/\/+$/, '')}/${encodeURIComponent(this.agentName)}${AGENT_CARD_PATH}`;
    const response = await this.fetchCard(agentUrl);
    if (response.status === 404) {
      throw new A2AError(errors.agentNotFound(this.agentName));
    }
    if (!response.ok) await this.throwHttpError(response);
    return this.cacheCard((await response.json()) as AgentCard, agentUrl);
  }

  async refreshAgentCard(): Promise<AgentCard> {
    this.cachedCard = null;
    this.cachedCardUrl = null;
    return this.agentCard();
  }

  /** Send a message; the server answers with the task it started or continued, or a direct reply. */
  async sendMessage(
    message: A2AMessageInput,
    config?: MessageSendConfiguration,
    options?: A2ARequestOptions
  ): Promise<SendMessageResult> {
    const result = await this.rpc(
      'message/send',
      { message: toMessage(message), ...(config && { configuration: config }) },
      options
    );
    return result as SendMessageResult;
  }

  /**
   * Stream a message: the task, then its status and artifact updates, until the final status
   * update (or a direct reply message). The client timeout applies to the wait for the response
   * and to the idle time between events, not to the total stream duration.
   */
  async *sendMessageStream(
    message: A2AMessageInput,
    config?: MessageSendConfiguration,
    options?: A2ARequestOptions
  ): AsyncGenerator<A2AStreamEvent> {
    yield* this.stream(
      'message/stream',
      { message: toMessage(message), ...(config && { configuration: config }) },
      options
    );
  }

  /** Reconnect to the stream of a task: the task as it is now, then its updates until the final one. */
  async *resubscribeTask(
    taskId: string,
    options?: A2ARequestOptions
  ): AsyncGenerator<A2AStreamEvent> {
    yield* this.stream('tasks/resubscribe', { id: taskId }, options);
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

  /** Answer a task that waits on the client (`input-required`) with text. */
  async continueTask(
    taskId: string,
    text: string,
    config?: MessageSendConfiguration,
    options?: A2ARequestOptions
  ): Promise<SendMessageResult> {
    return this.sendMessage({ role: 'user', parts: [textPart(text)], taskId }, config, options);
  }

  /**
   * Answer a task that waits in `input-required` for tool approvals (see
   * `readToolApprovalRequest`): the remote run goes on with these decisions.
   *
   * @example
   * ```ts
   * const waiting = readToolApprovalRequest(task);
   * if (waiting) await client.answerApprovals(task.id, { defaultDecision: { approved: true } });
   * ```
   */
  async answerApprovals(
    taskId: string,
    response: ToolApprovalResponse,
    config?: MessageSendConfiguration,
    options?: A2ARequestOptions
  ): Promise<SendMessageResult> {
    return this.sendMessage(
      { role: 'user', parts: [toolApprovalResponsePart(response)], taskId },
      config,
      options
    );
  }

  /** The caller's tasks on a Cogitator server (the `tasks/list` extension method). */
  async listTasks(filter?: Omit<TaskFilter, 'visibleTo'>): Promise<A2ATask[]> {
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
          const result = await this.sendMessage(
            { role: 'user', parts: [textPart(params.task)] },
            undefined,
            { signal: context?.signal, timeout: toolTimeout }
          );
          if (result.kind === 'message') {
            return { output: messageText(result), success: true };
          }

          const task = result;
          const state = task.status.state;
          const output = taskOutput(task);

          if (state === 'completed') {
            return { output, success: true, state };
          }

          if (state === 'input-required' || state === 'auth-required') {
            const pendingApprovals = readToolApprovalRequest(task);
            return {
              output,
              success: false,
              error: pendingApprovals
                ? `Remote agent waits for approval of ${pendingApprovals.map((p) => p.toolName).join(', ')} before it continues this task`
                : state === 'auth-required'
                  ? 'Remote agent requires authentication to continue this task'
                  : 'Remote agent requires more input to continue this task',
              taskId: task.id,
              state,
              ...(pendingApprovals && { pendingApprovals }),
            };
          }

          return {
            output,
            success: false,
            error: output || `Remote task ended in state: ${state}`,
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

  /** Register a webhook the server POSTs the task to on every status change. */
  async setPushNotificationConfig(
    taskId: string,
    config: PushNotificationConfig
  ): Promise<TaskPushNotificationConfig> {
    const result = await this.rpc('tasks/pushNotificationConfig/set', {
      taskId,
      pushNotificationConfig: config,
    });
    return result as TaskPushNotificationConfig;
  }

  async getPushNotificationConfig(
    taskId: string,
    configId?: string
  ): Promise<TaskPushNotificationConfig> {
    const result = await this.rpc(
      'tasks/pushNotificationConfig/get',
      configId === undefined ? { id: taskId } : { id: taskId, pushNotificationConfigId: configId }
    );
    return result as TaskPushNotificationConfig;
  }

  async listPushNotificationConfigs(taskId: string): Promise<TaskPushNotificationConfig[]> {
    const result = await this.rpc('tasks/pushNotificationConfig/list', { id: taskId });
    return result as TaskPushNotificationConfig[];
  }

  async deletePushNotificationConfig(taskId: string, configId: string): Promise<void> {
    await this.rpc('tasks/pushNotificationConfig/delete', {
      id: taskId,
      pushNotificationConfigId: configId,
    });
  }

  /** Whether the Agent Card carries an HS256 signature made with this shared secret. */
  async verifyAgentCard(secret: string): Promise<boolean> {
    return verifyAgentCardSignature(await this.agentCard(), secret);
  }

  /** The authenticated extended Agent Card (`agent/getAuthenticatedExtendedCard`). */
  async extendedAgentCard(): Promise<AgentCard> {
    const result = await this.rpc('agent/getAuthenticatedExtendedCard', undefined);
    return result as AgentCard;
  }

  asToolFromCard(card: AgentCard, options?: A2AToolOptions): Tool<{ task: string }, A2AToolResult> {
    return this.asTool({
      name: options?.name ?? card.name,
      description: options?.description ?? card.description ?? `Remote A2A agent: ${card.name}`,
      timeout: options?.timeout,
    });
  }

  private cacheCard(card: AgentCard, url: string): AgentCard {
    this.cachedCard = card;
    this.cachedCardUrl = url;
    return card;
  }

  private async fetchDefaultCard(): Promise<{ card: AgentCard; url: string }> {
    const paths = this.agentCardPath
      ? [this.agentCardPath]
      : [AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH];
    let lastResponse: Response | undefined;
    for (const path of paths) {
      const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      const response = await this.fetchCard(url);
      if (response.ok) {
        return { card: this.pickCard(await response.json()), url };
      }
      lastResponse = response;
      if (response.status !== 404) break;
    }
    return this.throwHttpError(lastResponse!);
  }

  /** The card a response holds; a pre-v0.3 Cogitator server lists several agents in an array. */
  private pickCard(data: unknown): AgentCard {
    const cards = (Array.isArray(data) ? data : [data]) as AgentCard[];
    if (cards.length === 0) {
      throw new A2AError(errors.internalError('Agent card response is empty array'));
    }
    if (!this.agentName) return cards[0];
    return cards.find((candidate) => candidate.name === this.agentName) ?? cards[0];
  }

  private fetchCard(url: string): Promise<Response> {
    return fetch(url, {
      headers: { Accept: 'application/json', ...this.headers },
      signal: AbortSignal.timeout(this.timeout),
    });
  }

  private resolveUrl(url: string, relativeTo: string): string {
    return new URL(url, relativeTo).toString();
  }

  /** The JSON-RPC endpoint: `rpcPath` at the base URL, or the `url` of the Agent Card. */
  private async endpoint(): Promise<string> {
    if (this.rpcPath !== undefined) {
      return `${this.baseUrl}${this.rpcPath.startsWith('/') ? this.rpcPath : `/${this.rpcPath}`}`;
    }
    const card = await this.agentCard();
    if (!card.url) {
      throw new A2AError(errors.internalError('Agent card has no url for its JSON-RPC endpoint'));
    }
    return this.resolveUrl(card.url, this.cachedCardUrl ?? `${this.baseUrl}/`);
  }

  private async rpc(
    method: string,
    params: unknown,
    options?: A2ARequestOptions
  ): Promise<unknown> {
    const endpoint = await this.endpoint();
    const id = this.generateRequestId();
    const timeoutSignal = AbortSignal.timeout(options?.timeout ?? this.timeout);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined && { params }),
        id,
      }),
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

  private async *stream(
    method: string,
    params: unknown,
    options?: A2ARequestOptions
  ): AsyncGenerator<A2AStreamEvent> {
    const endpoint = await this.endpoint();
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
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: this.generateRequestId() }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await this.throwHttpError(response);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        const json = (await response.json()) as JsonRpcResponse;
        if (json.error) throw new A2AError(json.error);
        if (json.result !== undefined) yield json.result as A2AStreamEvent;
        return;
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

          let response: JsonRpcResponse;
          try {
            response = JSON.parse(data) as JsonRpcResponse;
          } catch {
            process.stderr.write(`[a2a] Failed to parse SSE event: ${data.slice(0, 200)}\n`);
            continue;
          }

          if (response.error) throw new A2AError(response.error);
          if (response.result === undefined || response.result === null) continue;
          const event = response.result as A2AStreamEvent;
          yield event;
          if (isFinalEvent(event)) return;
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

  private generateRequestId(): string {
    return `req_${randomUUID()}`;
  }
}
