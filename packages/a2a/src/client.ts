import type { Tool, ToolApprovalRequest, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentCard,
  A2AMessageInput,
  A2ATask,
  A2AStreamEvent,
  A2AClientConfig,
  MessageSendConfiguration,
  MessageSendParams,
  PushNotificationConfig,
  SendMessageResult,
  TaskFilter,
  TaskPushNotificationConfig,
  TaskState,
} from './types.js';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH } from './types.js';
import type { JsonRpcError, JsonRpcResponse } from './json-rpc.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { legacyCardFromV1, verifyAgentCardSignature } from './agent-card.js';
import { verifyAgentCardJws, type AgentCardVerificationOptions } from './card-signing.js';
import {
  readToolApprovalRequest,
  toolApprovalResponsePart,
  type ToolApprovalResponse,
} from './approvals.js';
import { interruptResponsePart, readInterruptRequest, type TaskQuestion } from './questions.js';
import { artifactText, messageText, textPart, toMessage } from './protocol.js';
import { trimTrailingSlashes } from './url.js';
import {
  A2A_CONTENT_TYPE,
  A2A_VERSION_HEADER,
  normalizeProtocolVersion,
  type A2AProtocolVersion,
} from './version.js';
import {
  A2A_EXTENSIONS_HEADER,
  LEGACY_EXTENSIONS_HEADER,
  RUN_TIMEOUT_EXTENSION,
} from './extensions.js';
import type { ListTasksPage, ListTasksPageQuery } from './list-tasks.js';
import type { V1AgentCard, V1AgentInterface } from './v1/types.js';
import {
  readAgentCard,
  readListPushConfigsResponse,
  readListTasksResponse,
  readPushConfig,
  readSendMessageResponse,
  readStreamResponse,
  readTask,
} from './v1/schema.js';
import {
  messageFromV1,
  pushConfigFromV1,
  pushConfigToV1,
  sendMessageRequestToV1,
  streamEventFromV1,
  taskFromV1,
  taskStateToV1,
} from './v1/translate.js';
import { jsonRpcErrorFromRest } from './v1/errors.js';

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
  /**
   * The questions the remote agent's tools asked, when the task is `input-required` for them:
   * answer with `answerQuestions` (or an `interruptResponsePart` in a message that continues `taskId`)
   */
  pendingQuestions?: TaskQuestion[];
}

export interface A2ARequestOptions {
  /** Cancels the request (and an in-flight stream) */
  signal?: AbortSignal;
  /** Overrides the client timeout for this request; for streams it is the idle timeout between events */
  timeout?: number;
}

/** The endpoint the client talks to, once it read the Agent Card. */
export interface A2AClientEndpoint {
  /** The protocol version it speaks */
  protocolVersion: A2AProtocolVersion;
  /** Its binding: A2A 0.3 always goes over JSON-RPC */
  transport: 'JSONRPC' | 'HTTP+JSON';
  url: string;
  /** A2A 1.0: the tenant every request carries, from the chosen interface */
  tenant?: string;
}

const TOOL_NAME_MAX_LENGTH = 64;
const PROVIDER_SAFE_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;

/**
 * A tool name LLM providers accept, made from an Agent Card's name, which is meant for people
 * ("Research Agent"): the same rule and result as `normalizeToolName` from `@cogitator-ai/core`.
 */
function toolNameFromCard(name: string): string {
  if (PROVIDER_SAFE_NAME.test(name)) return name;
  let safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!/^[a-zA-Z_]/.test(safe)) safe = `_${safe}`;
  if (safe.length <= TOOL_NAME_MAX_LENGTH) return safe;
  const suffix = `_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  return `${safe.slice(0, TOOL_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Whether a card is an A2A 1.0 card: it lists `supportedInterfaces` and has none of the fields
 * of an A2A 0.3 card. A hybrid card (0.3 fields plus `supportedInterfaces`) is read as 0.3.
 */
function isV1Card(card: unknown): boolean {
  return (
    isRecord(card) &&
    Array.isArray(card.supportedInterfaces) &&
    typeof card.url !== 'string' &&
    typeof card.protocolVersion !== 'string'
  );
}

/** The A2A 1.0 interfaces of a card (pure or hybrid) this client speaks. */
function v1InterfacesOf(card: unknown): V1AgentInterface[] {
  if (!isRecord(card) || !Array.isArray(card.supportedInterfaces)) return [];
  return card.supportedInterfaces.filter(
    (entry): entry is V1AgentInterface =>
      isRecord(entry) &&
      typeof entry.url === 'string' &&
      (entry.protocolBinding === 'JSONRPC' || entry.protocolBinding === 'HTTP+JSON') &&
      typeof entry.protocolVersion === 'string' &&
      normalizeProtocolVersion(entry.protocolVersion) === '1.0'
  );
}

/**
 * The first JSON-RPC 0.3 interface a card lists in `supportedInterfaces`. A hybrid card's
 * signature covers that list and not `url`, so a client on 0.3 takes its endpoint from there.
 */
function legacyRpcInterface(card: unknown): V1AgentInterface | undefined {
  if (!isRecord(card) || !Array.isArray(card.supportedInterfaces)) return undefined;
  return card.supportedInterfaces.find(
    (entry): entry is V1AgentInterface =>
      isRecord(entry) &&
      typeof entry.url === 'string' &&
      entry.protocolBinding === 'JSONRPC' &&
      typeof entry.protocolVersion === 'string' &&
      normalizeProtocolVersion(entry.protocolVersion).startsWith('0.')
  );
}

interface CachedCard {
  /** The card in the A2A 0.3 form the client API speaks */
  card: AgentCard;
  /** The card as the server sent it, for signatures and interfaces */
  raw: AgentCard | V1AgentCard;
  url: string;
}

/** One HTTP+JSON call: the method, the path under the interface URL, the body. */
interface RestCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

/**
 * A2A client over JSON-RPC and HTTP+JSON. It reads the Agent Card at the base URL and talks to
 * the endpoint the card names: A2A 1.0 when the card offers it (`protocolVersion: 'auto'`),
 * else A2A 0.3 over JSON-RPC, so it talks to any A2A 0.3 or 1.0 server. Its API speaks the
 * A2A 0.3 model either way.
 */
export class A2AClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;
  private agentCardPath?: string;
  private rpcPath?: string;
  private agentName?: string;
  private protocolVersion: 'auto' | A2AProtocolVersion;
  private preferredTransport?: 'JSONRPC' | 'HTTP+JSON';
  private extensions: readonly string[];
  private cached: CachedCard | null = null;
  private resolvedEndpoint: A2AClientEndpoint | null = null;

  constructor(baseUrl: string, config?: A2AClientConfig) {
    this.baseUrl = trimTrailingSlashes(baseUrl);
    this.headers = config?.headers ?? {};
    this.timeout = config?.timeout ?? 30000;
    this.agentCardPath = config?.agentCardPath;
    this.rpcPath = config?.rpcPath;
    this.agentName = config?.agentName;
    this.protocolVersion = config?.protocolVersion ?? 'auto';
    this.preferredTransport = config?.transport;
    this.extensions = config?.extensions ?? [];
  }

  /**
   * The Agent Card: from `/.well-known/agent-card.json` at the base URL (or the pre-v0.3
   * `/.well-known/agent.json` when the server has no v0.3 card), or `agentCardPath`. With
   * `agentName` it is the card of that agent on a Cogitator server hosting several. An A2A 1.0
   * card comes in the A2A 0.3 form, its interfaces in `supportedInterfaces`.
   */
  async agentCard(): Promise<AgentCard> {
    return (await this.cachedCard()).card;
  }

  async refreshAgentCard(): Promise<AgentCard> {
    this.cached = null;
    this.resolvedEndpoint = null;
    return this.agentCard();
  }

  /**
   * The endpoint the client talks to: the protocol version, the binding, the URL and the tenant
   * it chose from the Agent Card.
   */
  async endpoint(): Promise<A2AClientEndpoint> {
    if (this.resolvedEndpoint) return this.resolvedEndpoint;
    this.resolvedEndpoint = await this.resolveEndpoint();
    return this.resolvedEndpoint;
  }

  /** Send a message; the server answers with the task it started or continued, or a direct reply. */
  async sendMessage(
    message: A2AMessageInput,
    config?: MessageSendConfiguration,
    options?: A2ARequestOptions
  ): Promise<SendMessageResult> {
    const params: MessageSendParams = {
      message: toMessage(message),
      ...(config && { configuration: config }),
    };
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      return (await this.rpc(endpoint, 'message/send', params, options)) as SendMessageResult;
    }
    const request = sendMessageRequestToV1(params, endpoint.tenant);
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(endpoint, 'SendMessage', request, options, this.timeoutExtension(config))
        : await this.rest(
            endpoint,
            { method: 'POST', path: '/message:send', body: request },
            options,
            this.timeoutExtension(config)
          );
    const response = readSendMessageResponse(result);
    return 'task' in response ? taskFromV1(response.task) : messageFromV1(response.message);
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
    const params: MessageSendParams = {
      message: toMessage(message),
      ...(config && { configuration: config }),
    };
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      yield* this.stream(endpoint, 'message/stream', params, options);
      return;
    }
    const request = sendMessageRequestToV1(params, endpoint.tenant);
    yield* endpoint.transport === 'JSONRPC'
      ? this.stream(
          endpoint,
          'SendStreamingMessage',
          request,
          options,
          this.timeoutExtension(config)
        )
      : this.restStream(
          endpoint,
          { method: 'POST', path: '/message:stream', body: request },
          options,
          this.timeoutExtension(config)
        );
  }

  /** Reconnect to the stream of a task: the task as it is now, then its updates until the final one. */
  async *resubscribeTask(
    taskId: string,
    options?: A2ARequestOptions
  ): AsyncGenerator<A2AStreamEvent> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      yield* this.stream(endpoint, 'tasks/resubscribe', { id: taskId }, options);
      return;
    }
    yield* endpoint.transport === 'JSONRPC'
      ? this.stream(endpoint, 'SubscribeToTask', this.withTenant(endpoint, { id: taskId }), options)
      : this.restStream(
          endpoint,
          { method: 'GET', path: `/tasks/${encodeURIComponent(taskId)}:subscribe` },
          options
        );
  }

  async getTask(taskId: string, historyLength?: number): Promise<A2ATask> {
    const endpoint = await this.endpoint();
    const params = historyLength === undefined ? { id: taskId } : { id: taskId, historyLength };
    if (endpoint.protocolVersion === '0.3') {
      return (await this.rpc(endpoint, 'tasks/get', params)) as A2ATask;
    }
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(endpoint, 'GetTask', this.withTenant(endpoint, params))
        : await this.rest(endpoint, {
            method: 'GET',
            path: `/tasks/${encodeURIComponent(taskId)}${
              historyLength === undefined ? '' : `?historyLength=${historyLength}`
            }`,
          });
    return taskFromV1(readTask(result));
  }

  async cancelTask(taskId: string): Promise<A2ATask> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      return (await this.rpc(endpoint, 'tasks/cancel', { id: taskId })) as A2ATask;
    }
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(endpoint, 'CancelTask', this.withTenant(endpoint, { id: taskId }))
        : await this.rest(endpoint, {
            method: 'POST',
            path: `/tasks/${encodeURIComponent(taskId)}:cancel`,
          });
    return taskFromV1(readTask(result));
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

  /**
   * Answer the questions a task waits on in `input-required` (see `readInterruptRequest`), by
   * question id: the remote run goes on with these answers.
   *
   * @example
   * ```ts
   * const questions = readInterruptRequest(task);
   * if (questions) await client.answerQuestions(task.id, { [questions[0].id]: { ok: true } });
   * ```
   */
  async answerQuestions(
    taskId: string,
    responses: Record<string, unknown>,
    config?: MessageSendConfiguration,
    options?: A2ARequestOptions
  ): Promise<SendMessageResult> {
    return this.sendMessage(
      { role: 'user', parts: [interruptResponsePart(responses)], taskId },
      config,
      options
    );
  }

  /**
   * The caller's tasks, newest first: over A2A 0.3 the Cogitator `tasks/list` extension method,
   * over A2A 1.0 the pages of `ListTasks` (with artifacts) up to `limit` after `offset`.
   */
  async listTasks(filter?: Omit<TaskFilter, 'visibleTo'>): Promise<A2ATask[]> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      const result = (await this.rpc(endpoint, 'tasks/list', filter ?? {})) as {
        tasks: A2ATask[];
      };
      return result.tasks;
    }
    const offset = filter?.offset ?? 0;
    const wanted = filter?.limit === undefined ? Infinity : offset + filter.limit;
    const tasks: A2ATask[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.listTasksPage({
        ...(filter?.contextId && { contextId: filter.contextId }),
        ...(filter?.state && { state: filter.state }),
        pageSize: 100,
        ...(pageToken && { pageToken }),
        includeArtifacts: true,
      });
      tasks.push(...page.tasks);
      pageToken = page.nextPageToken || undefined;
    } while (pageToken && tasks.length < wanted);
    return tasks.slice(offset, wanted === Infinity ? undefined : wanted);
  }

  /**
   * One page of the caller's tasks by A2A 1.0 `ListTasks`, the most recently updated first. Pass
   * the `nextPageToken` of a page as `pageToken` for the next one; it is `''` on the last page.
   * Needs a server that speaks A2A 1.0.
   */
  async listTasksPage(query?: ListTasksPageQuery): Promise<ListTasksPage> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      throw new A2AError(
        errors.unsupportedOperation('listTasksPage (ListTasks needs an A2A 1.0 server)')
      );
    }
    const params = {
      ...(query?.contextId && { contextId: query.contextId }),
      ...(query?.state && { status: taskStateToV1(query.state) }),
      ...(query?.pageSize !== undefined && { pageSize: query.pageSize }),
      ...(query?.pageToken && { pageToken: query.pageToken }),
      ...(query?.historyLength !== undefined && { historyLength: query.historyLength }),
      ...(query?.statusTimestampAfter && { statusTimestampAfter: query.statusTimestampAfter }),
      ...(query?.includeArtifacts !== undefined && { includeArtifacts: query.includeArtifacts }),
    };
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(endpoint, 'ListTasks', this.withTenant(endpoint, params))
        : await this.rest(endpoint, {
            method: 'GET',
            path: `/tasks${queryString(params)}`,
          });
    const page = readListTasksResponse(result);
    return {
      tasks: page.tasks.map(taskFromV1),
      nextPageToken: page.nextPageToken,
      pageSize: page.pageSize,
      totalSize: page.totalSize,
    };
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
            const pendingQuestions = readInterruptRequest(task);
            return {
              output,
              success: false,
              error: pendingApprovals?.length
                ? `Remote agent waits for approval of ${pendingApprovals.map((p) => p.toolName).join(', ')} before it continues this task`
                : pendingQuestions
                  ? `Remote agent waits for answers to ${pendingQuestions.map((q) => `${q.reason} ("${q.message}")`).join(', ')} before it continues this task`
                  : state === 'auth-required'
                    ? 'Remote agent requires authentication to continue this task'
                    : 'Remote agent requires more input to continue this task',
              taskId: task.id,
              state,
              ...(pendingApprovals?.length && { pendingApprovals }),
              ...(pendingQuestions && { pendingQuestions }),
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
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      const result = await this.rpc(endpoint, 'tasks/pushNotificationConfig/set', {
        taskId,
        pushNotificationConfig: config,
      });
      return result as TaskPushNotificationConfig;
    }
    const v1Config = pushConfigToV1(config, taskId);
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(
            endpoint,
            'CreateTaskPushNotificationConfig',
            this.withTenant(endpoint, v1Config)
          )
        : await this.rest(endpoint, {
            method: 'POST',
            path: `/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`,
            body: v1Config,
          });
    return { taskId, pushNotificationConfig: pushConfigFromV1(readPushConfig(result)) };
  }

  async getPushNotificationConfig(
    taskId: string,
    configId?: string
  ): Promise<TaskPushNotificationConfig> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      const result = await this.rpc(
        endpoint,
        'tasks/pushNotificationConfig/get',
        configId === undefined ? { id: taskId } : { id: taskId, pushNotificationConfigId: configId }
      );
      return result as TaskPushNotificationConfig;
    }
    if (configId === undefined) {
      const [first] = await this.listPushNotificationConfigs(taskId);
      if (!first) throw new A2AError(errors.pushNotificationConfigNotFound(taskId, taskId));
      return first;
    }
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(
            endpoint,
            'GetTaskPushNotificationConfig',
            this.withTenant(endpoint, { taskId, id: configId })
          )
        : await this.rest(endpoint, {
            method: 'GET',
            path: `/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs/${encodeURIComponent(configId)}`,
          });
    return { taskId, pushNotificationConfig: pushConfigFromV1(readPushConfig(result)) };
  }

  async listPushNotificationConfigs(taskId: string): Promise<TaskPushNotificationConfig[]> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      const result = await this.rpc(endpoint, 'tasks/pushNotificationConfig/list', { id: taskId });
      return result as TaskPushNotificationConfig[];
    }
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(
            endpoint,
            'ListTaskPushNotificationConfigs',
            this.withTenant(endpoint, { taskId })
          )
        : await this.rest(endpoint, {
            method: 'GET',
            path: `/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs`,
          });
    return readListPushConfigsResponse(result).configs.map((config) => ({
      taskId,
      pushNotificationConfig: pushConfigFromV1(config),
    }));
  }

  async deletePushNotificationConfig(taskId: string, configId: string): Promise<void> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      await this.rpc(endpoint, 'tasks/pushNotificationConfig/delete', {
        id: taskId,
        pushNotificationConfigId: configId,
      });
      return;
    }
    if (endpoint.transport === 'JSONRPC') {
      await this.rpc(
        endpoint,
        'DeleteTaskPushNotificationConfig',
        this.withTenant(endpoint, { taskId, id: configId })
      );
      return;
    }
    await this.rest(endpoint, {
      method: 'DELETE',
      path: `/tasks/${encodeURIComponent(taskId)}/pushNotificationConfigs/${encodeURIComponent(configId)}`,
    });
  }

  /**
   * Whether the Agent Card carries a valid signature. With a string, an HS256 signature made with
   * this shared secret (deprecated). With options, a JWS signature (ES256, RS256, PS256, EdDSA)
   * over the card's A2A 1.0 form, checked with a key from `keys`, `resolveKey`, or the JWKS at
   * its `jku` when `trustJku` allows it (by default only a `jku` on the card's own origin).
   */
  async verifyAgentCard(secretOrOptions: string | AgentCardVerificationOptions): Promise<boolean> {
    const { raw, url } = await this.cachedCard();
    if (typeof secretOrOptions === 'string') return verifyAgentCardSignature(raw, secretOrOptions);
    return verifyAgentCardJws(raw, { cardUrl: url, ...secretOrOptions });
  }

  /**
   * The authenticated extended Agent Card (`agent/getAuthenticatedExtendedCard`, A2A 1.0
   * `GetExtendedAgentCard`), in the A2A 0.3 form.
   */
  async extendedAgentCard(): Promise<AgentCard> {
    const endpoint = await this.endpoint();
    if (endpoint.protocolVersion === '0.3') {
      return (await this.rpc(
        endpoint,
        'agent/getAuthenticatedExtendedCard',
        undefined
      )) as AgentCard;
    }
    const result =
      endpoint.transport === 'JSONRPC'
        ? await this.rpc(endpoint, 'GetExtendedAgentCard', this.withTenant(endpoint, {}))
        : await this.rest(endpoint, { method: 'GET', path: '/extendedAgentCard' });
    return legacyCardFromV1(readAgentCard(result));
  }

  asToolFromCard(card: AgentCard, options?: A2AToolOptions): Tool<{ task: string }, A2AToolResult> {
    return this.asTool({
      name: options?.name ?? toolNameFromCard(card.name),
      description: options?.description ?? card.description ?? `Remote A2A agent: ${card.name}`,
      timeout: options?.timeout,
    });
  }

  private async cachedCard(): Promise<CachedCard> {
    if (this.cached) return this.cached;

    const fetched = await this.fetchDefaultCard();
    if (!this.agentName || fetched.card.name === this.agentName) {
      this.cached = fetched;
      return fetched;
    }

    const rpcUrl = this.cardRpcUrl(fetched);
    const agentUrl = `${trimTrailingSlashes(this.resolveUrl(rpcUrl, fetched.url))}/${encodeURIComponent(this.agentName)}${AGENT_CARD_PATH}`;
    const response = await this.fetchCard(agentUrl);
    if (response.status === 404) {
      throw new A2AError(errors.agentNotFound(this.agentName));
    }
    if (!response.ok) await this.throwHttpError(response);
    this.cached = this.readCard(await response.json(), agentUrl);
    return this.cached;
  }

  /** The JSON-RPC endpoint a card names: its `url`, or its first JSON-RPC interface. */
  private cardRpcUrl({ card, raw }: CachedCard): string {
    if (!isV1Card(raw)) return legacyRpcInterface(raw)?.url ?? card.url;
    const rpc = v1InterfacesOf(raw).find((entry) => entry.protocolBinding === 'JSONRPC');
    return rpc?.url ?? card.url;
  }

  private async fetchDefaultCard(): Promise<CachedCard> {
    const paths = this.agentCardPath
      ? [this.agentCardPath]
      : [AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH];
    let lastResponse: Response | undefined;
    for (const path of paths) {
      const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
      const response = await this.fetchCard(url);
      if (response.ok) {
        return this.readCard(this.pickCard(await response.json()), url);
      }
      lastResponse = response;
      if (response.status !== 404) break;
    }
    return this.throwHttpError(lastResponse!);
  }

  /** A card as the server sent it, with its A2A 0.3 form. */
  private readCard(data: unknown, url: string): CachedCard {
    if (isV1Card(data)) {
      const raw = readAgentCard(data);
      return { card: legacyCardFromV1(raw), raw, url };
    }
    const card = data as AgentCard;
    return { card, raw: card, url };
  }

  /** The card a response holds; a pre-v0.3 Cogitator server lists several agents in an array. */
  private pickCard(data: unknown): unknown {
    const cards = Array.isArray(data) ? data : [data];
    if (cards.length === 0) {
      throw new A2AError(errors.internalError('Agent card response is empty array'));
    }
    if (!this.agentName) return cards[0];
    return (
      cards.find((candidate) => isRecord(candidate) && candidate.name === this.agentName) ??
      cards[0]
    );
  }

  /**
   * Fetch a card. Only a client set to speak A2A 1.0 names the version; otherwise the server
   * answers with its A2A 0.3 card, which a server of both versions extends with its 1.0
   * interfaces.
   */
  private fetchCard(url: string): Promise<Response> {
    return fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(this.protocolVersion === '1.0' && { [A2A_VERSION_HEADER]: '1.0' }),
        ...this.headers,
      },
      signal: AbortSignal.timeout(this.timeout),
    });
  }

  private resolveUrl(url: string, relativeTo: string): string {
    return new URL(url, relativeTo).toString();
  }

  private async resolveEndpoint(): Promise<A2AClientEndpoint> {
    if (this.rpcPath !== undefined) {
      const url = `${this.baseUrl}${this.rpcPath.startsWith('/') ? this.rpcPath : `/${this.rpcPath}`}`;
      return this.protocolVersion === '1.0'
        ? {
            protocolVersion: '1.0',
            transport: 'JSONRPC',
            url,
            ...(this.agentName && { tenant: this.agentName }),
          }
        : { protocolVersion: '0.3', transport: 'JSONRPC', url };
    }

    const cached = await this.cachedCard();
    const relativeTo = cached.url;
    if (this.protocolVersion !== '0.3') {
      const interfaces = v1InterfacesOf(cached.raw);
      const chosen =
        (this.preferredTransport &&
          interfaces.find((entry) => entry.protocolBinding === this.preferredTransport)) ??
        interfaces[0];
      if (chosen) {
        return {
          protocolVersion: '1.0',
          transport: chosen.protocolBinding === 'HTTP+JSON' ? 'HTTP+JSON' : 'JSONRPC',
          url: this.resolveUrl(chosen.url, relativeTo),
          ...(chosen.tenant && { tenant: chosen.tenant }),
        };
      }
      if (this.protocolVersion === '1.0') {
        throw new A2AError(
          errors.versionNotSupported('1.0', [
            normalizeProtocolVersion(cached.card.protocolVersion) || '0.3',
          ])
        );
      }
    }

    const legacy = legacyRpcInterface(cached.raw);
    if (legacy) {
      return {
        protocolVersion: '0.3',
        transport: 'JSONRPC',
        url: this.resolveUrl(legacy.url, relativeTo),
      };
    }
    if (isV1Card(cached.raw)) {
      throw new A2AError(errors.versionNotSupported('0.3', ['1.0']));
    }
    if (!cached.card.url) {
      throw new A2AError(errors.internalError('Agent card has no url for its JSON-RPC endpoint'));
    }
    return {
      protocolVersion: '0.3',
      transport: 'JSONRPC',
      url: this.resolveUrl(cached.card.url, relativeTo),
    };
  }

  private withTenant<T extends object>(endpoint: A2AClientEndpoint, params: T): T {
    return endpoint.tenant ? { ...params, tenant: endpoint.tenant } : params;
  }

  /** The extensions a request asks for: the configured ones, plus run-timeout when it sets one. */
  private timeoutExtension(config: MessageSendConfiguration | undefined): string[] {
    return config?.timeout !== undefined ? [RUN_TIMEOUT_EXTENSION] : [];
  }

  /** The headers of a request to an endpoint: the version, the extensions, the configured ones. */
  private requestHeaders(
    endpoint: A2AClientEndpoint,
    accept: string,
    extra: readonly string[] = []
  ): Record<string, string> {
    const extensions = [...new Set([...this.extensions, ...extra])];
    const v1 = endpoint.protocolVersion === '1.0';
    return {
      'Content-Type':
        v1 && endpoint.transport === 'HTTP+JSON' ? A2A_CONTENT_TYPE : 'application/json',
      Accept: accept,
      ...(v1 && { [A2A_VERSION_HEADER]: '1.0' }),
      ...(extensions.length > 0 && {
        [v1 ? A2A_EXTENSIONS_HEADER : LEGACY_EXTENSIONS_HEADER]: extensions.join(', '),
      }),
      ...this.headers,
    };
  }

  private async rpc(
    endpoint: A2AClientEndpoint,
    method: string,
    params: unknown,
    options?: A2ARequestOptions,
    extensions?: readonly string[]
  ): Promise<unknown> {
    const id = this.generateRequestId();
    const timeoutSignal = AbortSignal.timeout(options?.timeout ?? this.timeout);
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: this.requestHeaders(endpoint, 'application/json', extensions),
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

  /** One call of the HTTP+JSON binding; a 204 answers with undefined. */
  private async rest(
    endpoint: A2AClientEndpoint,
    call: RestCall,
    options?: A2ARequestOptions,
    extensions?: readonly string[]
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(options?.timeout ?? this.timeout);
    const response = await fetch(this.restUrl(endpoint, call.path), {
      method: call.method,
      headers: this.requestHeaders(endpoint, `${A2A_CONTENT_TYPE}, application/json`, extensions),
      ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
      signal: options?.signal ? combineSignals(options.signal, timeoutSignal) : timeoutSignal,
    });
    if (!response.ok) await this.throwHttpError(response);
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  /** The URL of a REST path under the interface, with the tenant segment it names. */
  private restUrl(endpoint: A2AClientEndpoint, path: string): string {
    const tenant = endpoint.tenant ? `/${encodeURIComponent(endpoint.tenant)}` : '';
    return `${trimTrailingSlashes(endpoint.url)}${tenant}${path}`;
  }

  private stream(
    endpoint: A2AClientEndpoint,
    method: string,
    params: unknown,
    options?: A2ARequestOptions,
    extensions?: readonly string[]
  ): AsyncGenerator<A2AStreamEvent> {
    const v1 = endpoint.protocolVersion === '1.0';
    return this.openStream(
      endpoint.url,
      {
        method: 'POST',
        headers: this.requestHeaders(endpoint, 'text/event-stream', extensions),
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: this.generateRequestId() }),
      },
      (data) => {
        const response = JSON.parse(data) as JsonRpcResponse;
        if (response.error) throw new A2AError(response.error);
        if (response.result === undefined || response.result === null) return undefined;
        return v1
          ? streamEventFromV1(readStreamResponse(response.result))
          : (response.result as A2AStreamEvent);
      },
      (json) => {
        const response = json as JsonRpcResponse;
        if (response.error) throw new A2AError(response.error);
        if (response.result === undefined) return undefined;
        return v1
          ? streamEventFromV1(readStreamResponse(response.result))
          : (response.result as A2AStreamEvent);
      },
      options
    );
  }

  private restStream(
    endpoint: A2AClientEndpoint,
    call: RestCall,
    options?: A2ARequestOptions,
    extensions?: readonly string[]
  ): AsyncGenerator<A2AStreamEvent> {
    const read = (value: unknown) => {
      if (isRecord(value) && 'error' in value) {
        const error = jsonRpcErrorFromRest(500, value);
        throw new A2AError(error ?? errors.internalError('A2A stream failed'));
      }
      return streamEventFromV1(readStreamResponse(value));
    };
    return this.openStream(
      this.restUrl(endpoint, call.path),
      {
        method: call.method,
        headers: this.requestHeaders(endpoint, 'text/event-stream', extensions),
        ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
      },
      (data) => read(JSON.parse(data)),
      read,
      options
    );
  }

  /**
   * Open a stream and yield its events until the final one. `frame` reads the data of one SSE
   * event (undefined to skip it), `single` the JSON body a server sent instead of a stream.
   */
  private async *openStream(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    frame: (data: string) => A2AStreamEvent | undefined,
    single: (json: unknown) => A2AStreamEvent | undefined,
    options?: A2ARequestOptions
  ): AsyncGenerator<A2AStreamEvent> {
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
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (!response.ok) {
        await this.throwHttpError(response);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        const event = single(await response.json());
        if (event !== undefined) yield event;
        return;
      }

      if (!response.body) return;

      yield* this.parseSSEStream(response.body, frame, armTimer);
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
   * Surface the error body a server sent with a non-2xx status: a JSON-RPC error, or the
   * `google.rpc.Status` of the HTTP+JSON binding.
   */
  private async throwHttpError(response: Response): Promise<never> {
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const { code, message, data, status } = parsed.error;
      if (typeof code === 'number' && typeof status !== 'string') {
        const error: JsonRpcError = {
          code,
          message: typeof message === 'string' ? message : `HTTP ${response.status}`,
          ...(data !== undefined && { data }),
        };
        throw new A2AError(error);
      }
      const rest = jsonRpcErrorFromRest(response.status, parsed);
      if (rest) throw new A2AError(rest);
    }
    throw new A2AError(errors.internalError(`HTTP ${response.status}: ${response.statusText}`));
  }

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    frame: (data: string) => A2AStreamEvent | undefined,
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

        for (const raw of frames) {
          const data = this.extractSseData(raw);
          if (!data || data === '[DONE]') continue;

          let event: A2AStreamEvent | undefined;
          try {
            event = frame(data);
          } catch (error) {
            if (error instanceof A2AError) throw error;
            process.stderr.write(`[a2a] Failed to parse SSE event: ${data.slice(0, 200)}\n`);
            continue;
          }
          if (event === undefined) continue;
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

/** Query parameters of a GET of the HTTP+JSON binding: `?name=value&...`, or `''` for none. */
function queryString(params: Record<string, string | number | boolean>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) query.set(name, String(value));
  const text = query.toString();
  return text ? `?${text}` : '';
}
