import { MAX_RUN_TIMEOUT_MS, resolveSseHeartbeatMs } from '@cogitator-ai/server-shared';
import type { Agent as IAgent } from '@cogitator-ai/types';
import type {
  A2AServerConfig,
  AgentCard,
  AgentProvider,
  A2ATask,
  MessageSendConfiguration,
  MessageSendParams,
  TaskFilter,
  CogitatorLike,
  PushNotificationStore,
  TaskPushNotificationConfig,
  A2AAuthConfig,
  A2ACaller,
  Part,
} from './types.js';
import type { JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';
import { parseJsonRpcRequest, createSuccessResponse, createErrorResponse } from './json-rpc.js';
import { TaskManager, type TaskEvent } from './task-manager.js';
import { generateAgentCard, signAgentCard } from './agent-card.js';
import type { AgentCardSigningOptions } from './agent-card.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { InMemoryTaskStore } from './task-store.js';
import {
  InMemoryPushNotificationStore,
  PushNotificationSender,
  validateWebhookUrl,
} from './push-notifications.js';
import { isStreamFinalState } from './types.js';
import { isTaskVisibleTo, publicTask } from './ownership.js';
import {
  parseDeletePushNotificationConfigParams,
  parseGetPushNotificationConfigParams,
  parseListTasksParams,
  parseMessageSendParams,
  parseTaskIdParams,
  parseTaskPushNotificationConfig,
  parseTaskQueryParams,
} from './protocol.js';

type HeaderGetter = (name: string) => string | null | undefined;

const MAX_LIST_LIMIT = 1000;

/** The run time limit a client may ask for when neither the agent nor the server sets one: the Cogitator run default. */
const DEFAULT_MAX_RUN_TIMEOUT_MS = 120_000;

/** JSON-RPC methods answered with a stream of events (A2A v0.3, sections 7.2 and 7.9). */
export const STREAMING_METHODS: readonly string[] = ['message/stream', 'tasks/resubscribe'];

/** Options of one request, set by the framework adapters. */
export interface A2AHandleOptions {
  /** The agent the request is addressed to by its endpoint; it wins over an `agentName` param */
  agentName?: string;
}

/** Options for building an Agent Card. */
export interface AgentCardRequestOptions {
  /**
   * Absolute URL the framework adapter is mounted at (origin plus mount path). The card's `url`
   * is derived from it when the server has no `cardUrl`.
   */
  baseUrl?: string;
}

type RequestId = string | number | null;

function requestIdOf(body: unknown): RequestId {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

/** The MIME type a part is delivered as, for `acceptedOutputModes`. */
function partMimeType(part: Part): string {
  switch (part.kind) {
    case 'text':
      return 'text/plain';
    case 'data':
      return 'application/json';
    case 'file':
      return part.file.mimeType ?? 'application/octet-stream';
  }
}

/** The events of one task, queued until the stream that relays them takes them. */
class TaskEventQueue {
  private queue: TaskEvent[] = [];
  private wake: (() => void) | null = null;
  private readonly listener = (event: TaskEvent) => {
    if (this.taskId !== null && event.taskId === this.taskId) {
      this.queue.push(event);
      this.notify();
    }
  };

  constructor(
    private readonly manager: TaskManager,
    public taskId: string | null
  ) {
    manager.on('event', this.listener);
  }

  notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  shift(): TaskEvent | undefined {
    return this.queue.shift();
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  close(): void {
    this.manager.removeListener('event', this.listener);
    this.notify();
  }
}

export class A2AServer {
  private agents: Record<string, IAgent>;
  private defaultAgentName: string;
  private cogitator: CogitatorLike;
  private taskManager: TaskManager;
  /** The path the framework adapters serve JSON-RPC on, and the cards advertise without `cardUrl`. */
  readonly basePath: string;
  /** How often the framework adapters write a heartbeat on an open stream; `0` for never */
  readonly sseHeartbeatMs: number;
  private cardUrl?: string;
  private agentVersion?: string;
  private provider?: AgentProvider;
  private maxRunTimeoutMs: number;
  private pushNotificationStore: PushNotificationStore;
  private pushSender: PushNotificationSender;
  private cardSigning?: AgentCardSigningOptions;
  private extendedCardGenerator?: (agentName: string) => AgentCard;
  private allowPrivateUrls: boolean;
  private auth?: A2AAuthConfig;

  constructor(config: A2AServerConfig) {
    const agentNames = Object.keys(config.agents);
    if (agentNames.length === 0) {
      throw new Error('A2AServer requires at least one agent');
    }

    this.agents = config.agents;
    this.defaultAgentName = agentNames[0];
    this.cogitator = config.cogitator;
    this.basePath = config.basePath ?? '/a2a';
    if (!this.basePath.startsWith('/')) {
      throw new Error(
        `A2AServer basePath must be a path starting with "/", got "${this.basePath}"`
      );
    }
    const maxRunTimeoutMs = config.maxRunTimeoutMs ?? DEFAULT_MAX_RUN_TIMEOUT_MS;
    if (
      !Number.isInteger(maxRunTimeoutMs) ||
      maxRunTimeoutMs <= 0 ||
      maxRunTimeoutMs > MAX_RUN_TIMEOUT_MS
    ) {
      throw new Error(
        `A2AServer maxRunTimeoutMs must be a positive integer of at most ${MAX_RUN_TIMEOUT_MS}, got ${maxRunTimeoutMs}`
      );
    }
    this.maxRunTimeoutMs = maxRunTimeoutMs;
    this.sseHeartbeatMs = resolveSseHeartbeatMs(config.sseHeartbeatMs);
    this.cardUrl = config.cardUrl ? config.cardUrl.replace(/\/+$/, '') : undefined;
    this.agentVersion = config.agentVersion;
    this.provider = config.provider;
    this.cardSigning = config.cardSigning;
    this.extendedCardGenerator = config.extendedCardGenerator;
    this.allowPrivateUrls = config.allowPrivateUrls ?? false;
    this.auth = config.auth;

    this.pushNotificationStore =
      config.pushNotificationStore ?? new InMemoryPushNotificationStore();
    this.pushSender = new PushNotificationSender(this.pushNotificationStore, this.allowPrivateUrls);

    this.taskManager = new TaskManager({
      taskStore: config.taskStore ?? new InMemoryTaskStore(),
    });

    this.taskManager.on('event', (event: TaskEvent) => {
      if (event.kind !== 'status-update') return;
      this.taskManager
        .getTask(event.taskId)
        .then((task) => this.pushSender.notify(publicTask(task)))
        .catch(() => {});
    });
  }

  /**
   * Extract the credential configured by `auth` from request headers:
   * the token of an `Authorization: Bearer` header, or the API key header.
   * Framework adapters call this and pass the result to handleJsonRpc / handleJsonRpcStream.
   */
  getAuthToken(getHeader: HeaderGetter): string | undefined {
    if (!this.auth) return undefined;
    if (this.auth.type === 'bearer') {
      const header = getHeader('authorization');
      const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
      return match ? match[1].trim() : undefined;
    }
    const key = getHeader(this.auth.headerName ?? 'x-api-key');
    return key ? key.trim() || undefined : undefined;
  }

  /** The `WWW-Authenticate` challenge of a 401 response, when the auth scheme has one. */
  get authChallenge(): string | undefined {
    return this.auth?.type === 'bearer' ? 'Bearer realm="a2a"' : undefined;
  }

  /** Whether the server hosts an agent under this name. */
  hasAgent(agentName: string): boolean {
    return Object.hasOwn(this.agents, agentName);
  }

  /**
   * The Agent Card of an agent (the first one by default). Its `url` is the agent's JSON-RPC
   * endpoint: `cardUrl`, or `baseUrl` plus `basePath`, and `/<agent name>` after it for every
   * agent but the first.
   */
  getAgentCard(agentName?: string, options?: AgentCardRequestOptions): AgentCard {
    const name = agentName ?? this.defaultAgentName;
    if (!this.hasAgent(name)) throw new A2AError(errors.agentNotFound(name));
    const card = generateAgentCard(this.agents[name], {
      url: this.agentEndpoint(name, options?.baseUrl),
      version: this.agentVersion,
      provider: this.provider,
      capabilities: { streaming: true, pushNotifications: true },
      supportsAuthenticatedExtendedCard: !!this.extendedCardGenerator,
    });
    if (this.auth) {
      const schemeName = this.auth.type === 'bearer' ? 'bearer' : 'apiKey';
      card.securitySchemes = {
        [schemeName]:
          this.auth.type === 'bearer'
            ? { type: 'http', scheme: 'bearer' }
            : { type: 'apiKey', in: 'header', name: this.auth.headerName ?? 'x-api-key' },
      };
      card.security = [{ [schemeName]: [] }];
    }
    return this.signed(card);
  }

  /** The cards of every agent, in the order they were registered. */
  getAgentCards(options?: AgentCardRequestOptions): AgentCard[] {
    return Object.keys(this.agents).map((name) => this.getAgentCard(name, options));
  }

  private agentEndpoint(agentName: string, baseUrl?: string): string {
    const shared = this.cardUrl ?? `${(baseUrl ?? '').replace(/\/+$/, '')}${this.basePath}`;
    return agentName === this.defaultAgentName
      ? shared
      : `${shared.replace(/\/+$/, '')}/${encodeURIComponent(agentName)}`;
  }

  private signed(card: AgentCard): AgentCard {
    return this.cardSigning ? signAgentCard(card, this.cardSigning) : card;
  }

  /**
   * Answer a JSON-RPC request that is not streamed. Returns null for a notification (a request
   * without `id`).
   */
  async handleJsonRpc(
    body: unknown,
    authToken?: string,
    options?: A2AHandleOptions
  ): Promise<JsonRpcResponse | null> {
    let request: JsonRpcRequest;
    try {
      request = this.parseRequest(body);
    } catch (e) {
      return createErrorResponse(requestIdOf(body), errors.clientJsonRpcError(e, 'parse'));
    }

    let caller: A2ACaller | undefined;
    try {
      caller = await this.authenticate(authToken);
    } catch (e) {
      if (request.id === undefined) return null;
      return createErrorResponse(request.id, errors.clientJsonRpcError(e, 'Authentication error'));
    }

    try {
      const result = await this.routeMethod(request.method, request.params, caller, options);
      if (request.id === undefined) return null;
      return createSuccessResponse(request.id, result);
    } catch (e) {
      if (request.id === undefined) return null;
      return createErrorResponse(
        request.id,
        errors.clientJsonRpcError(e, `${request.method} failed`)
      );
    }
  }

  /**
   * Answer a JSON-RPC request with a stream of JSON-RPC responses, each the data of one SSE
   * event: for `message/stream` and `tasks/resubscribe` the task, then its status and artifact
   * updates until the `final` one; a failure ends the stream with an error response. Any other
   * method yields its single response.
   */
  async *handleJsonRpcStream(
    body: unknown,
    authToken?: string,
    signal?: AbortSignal,
    options?: A2AHandleOptions
  ): AsyncGenerator<JsonRpcResponse> {
    let request: JsonRpcRequest;
    try {
      request = this.parseRequest(body);
    } catch (e) {
      yield createErrorResponse(requestIdOf(body), errors.clientJsonRpcError(e, 'parse'));
      return;
    }
    const id: RequestId = request.id ?? null;

    let caller: A2ACaller | undefined;
    try {
      caller = await this.authenticate(authToken);
    } catch (e) {
      yield createErrorResponse(id, errors.clientJsonRpcError(e, 'Authentication error'));
      return;
    }

    if (!STREAMING_METHODS.includes(request.method)) {
      const response = await this.handleJsonRpc(body, authToken, options);
      if (response) yield response;
      return;
    }

    try {
      const events =
        request.method === 'message/stream'
          ? this.streamMessage(request.params, caller, options, signal)
          : this.resubscribe(request.params, caller, signal);
      for await (const event of events) {
        yield createSuccessResponse(id, event);
      }
    } catch (e) {
      if (signal?.aborted) return;
      yield createErrorResponse(id, errors.clientJsonRpcError(e, `${request.method} failed`));
    }
  }

  private parseRequest(body: unknown): JsonRpcRequest {
    const parsed = parseJsonRpcRequest(body);
    if (Array.isArray(parsed)) {
      throw new A2AError(errors.invalidRequest('Batch requests are not supported'));
    }
    return parsed;
  }

  /**
   * The events of `message/stream`: the task as it starts, then its updates until the final
   * status update.
   */
  private async *streamMessage(
    rawParams: unknown,
    caller: A2ACaller | undefined,
    options: A2AHandleOptions | undefined,
    signal: AbortSignal | undefined
  ): AsyncGenerator<A2ATask | TaskEvent> {
    const params = parseMessageSendParams(rawParams);
    const { agentName, agent } = this.resolveAgent(params, options);
    const { message, configuration } = params;
    this.validateInitialPushConfig(configuration);
    if (signal?.aborted) return;

    const queue = new TaskEventQueue(this.taskManager, message.taskId ?? null);
    let executingTaskId: string | null = null;
    let executionPromise: Promise<unknown> | null = null;
    const onAbort = () => {
      if (executingTaskId) this.taskManager.abortExecution(executingTaskId);
      queue.notify();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const task = await this.startTask(params, caller);
      queue.taskId = task.id;

      let executionDone = false;
      let executionError: unknown;
      executingTaskId = task.id;
      executionPromise = this.taskManager
        .executeTask(task, this.cogitator, agent, message, {
          stream: true,
          timeout: this.runTimeout(agent, configuration?.timeout),
          ...(caller && { userId: caller.userId }),
        })
        .then(
          () => {
            executionDone = true;
            queue.notify();
          },
          (error: unknown) => {
            executionError = error;
            executionDone = true;
            queue.notify();
          }
        );

      yield this.shapeTask(task, configuration);

      while (!signal?.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
          if (event.kind === 'status-update' && event.final) return;
          continue;
        }
        if (executionDone) {
          if (executionError !== undefined) throw executionError;
          throw new A2AError(
            errors.internalError(`Task ${task.id} of ${agentName} ended without a final status`)
          );
        }
        await queue.wait();
      }
    } finally {
      queue.close();
      signal?.removeEventListener('abort', onAbort);
      if (executingTaskId) this.taskManager.abortExecution(executingTaskId);
      if (executionPromise) await executionPromise;
    }
  }

  /**
   * The events of `tasks/resubscribe`: the task as it is now, then, while it still runs in this
   * process, its updates until the final status update.
   */
  private async *resubscribe(
    rawParams: unknown,
    caller: A2ACaller | undefined,
    signal: AbortSignal | undefined
  ): AsyncGenerator<A2ATask | TaskEvent> {
    const { id } = parseTaskIdParams(rawParams);
    const queue = new TaskEventQueue(this.taskManager, id);
    const onAbort = () => queue.notify();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const task = await this.visibleTask(id, caller);
      yield this.shapeTask(task);
      if (isStreamFinalState(task.status.state)) return;

      while (!signal?.aborted) {
        const event = queue.shift();
        if (event) {
          yield event;
          if (event.kind === 'status-update' && event.final) return;
          continue;
        }
        if (!this.taskManager.isExecuting(id)) return;
        await queue.wait();
      }
    } finally {
      queue.close();
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The caller of a request: undefined when there is no auth or `validate`
   * admitted it without a user. Throws `unauthorized` otherwise.
   */
  private async authenticate(authToken?: string): Promise<A2ACaller | undefined> {
    if (!this.auth) return undefined;
    if (!authToken) {
      throw new A2AError(errors.unauthorized('Authentication required'));
    }
    const verdict = await this.auth.validate(authToken);
    if (!verdict) {
      throw new A2AError(errors.unauthorized('Invalid credentials'));
    }
    return verdict === true ? undefined : verdict;
  }

  /** A task the caller may see; another user's task is reported as not found. */
  private async visibleTask(taskId: string, caller: A2ACaller | undefined): Promise<A2ATask> {
    const task = await this.taskManager.getTask(taskId);
    if (!isTaskVisibleTo(task, caller?.userId)) {
      throw new A2AError(errors.taskNotFound(taskId));
    }
    return task;
  }

  /** Rejects joining a context that holds another user's tasks. */
  private async assertContextAvailable(
    contextId: string | undefined,
    caller: A2ACaller | undefined
  ): Promise<void> {
    if (!contextId) return;
    const tasks = await this.taskManager.listTasks({ contextId });
    if (tasks.some((task) => !isTaskVisibleTo(task, caller?.userId))) {
      throw new A2AError(errors.invalidParams(`Unknown contextId: ${contextId}`));
    }
  }

  private resolveAgent(
    params: Pick<MessageSendParams, 'agentName'>,
    options?: A2AHandleOptions
  ): { agentName: string; agent: IAgent } {
    const agentName = options?.agentName ?? params.agentName ?? this.defaultAgentName;
    if (!this.hasAgent(agentName)) throw new A2AError(errors.agentNotFound(agentName));
    return { agentName, agent: this.agents[agentName] };
  }

  /**
   * The run time limit for a task: none of its own unless the client asks for one, and what the
   * client asks for never beyond the agent's `timeout`, or `maxRunTimeoutMs` for an agent
   * without one. A client can shorten a run, never lift or remove the operator's limit.
   */
  private runTimeout(agent: IAgent, requested: number | undefined): number | undefined {
    if (requested === undefined) return undefined;
    const agentTimeout = agent.config?.timeout;
    const ceiling =
      agentTimeout !== undefined && agentTimeout > 0
        ? Math.min(agentTimeout, MAX_RUN_TIMEOUT_MS)
        : this.maxRunTimeoutMs;
    return Math.min(requested, ceiling);
  }

  /** A new task for the message, or the task it continues, ready to execute. */
  private async startTask(
    params: MessageSendParams,
    caller: A2ACaller | undefined
  ): Promise<A2ATask> {
    const { message, configuration } = params;
    if (message.taskId) {
      const existing = await this.visibleTask(message.taskId, caller);
      if (message.contextId && message.contextId !== existing.contextId) {
        throw new A2AError(
          errors.invalidParams(`contextId does not match the context of task ${existing.id}`)
        );
      }
      return this.taskManager.continueTask(message.taskId, message);
    }
    await this.assertContextAvailable(message.contextId, caller);
    const task = await this.taskManager.createTask(message, message.contextId, caller?.userId);
    await this.registerInitialPushConfig(task.id, configuration);
    return task;
  }

  private async routeMethod(
    method: string,
    params: unknown,
    caller: A2ACaller | undefined,
    options: A2AHandleOptions | undefined
  ): Promise<unknown> {
    switch (method) {
      case 'message/send':
        return this.handleSendMessage(params, caller, options);
      case 'message/stream':
      case 'tasks/resubscribe':
        throw new A2AError(
          errors.unsupportedOperation(`${method} streams: use handleJsonRpcStream`)
        );
      case 'tasks/get':
        return this.handleGetTask(params, caller);
      case 'tasks/cancel':
        return this.handleCancelTask(params, caller);
      case 'tasks/list':
        return this.handleListTasks(params, caller);
      case 'tasks/pushNotificationConfig/set':
        return this.handleSetPushNotificationConfig(params, caller);
      case 'tasks/pushNotificationConfig/get':
        return this.handleGetPushNotificationConfig(params, caller);
      case 'tasks/pushNotificationConfig/list':
        return this.handleListPushNotificationConfigs(params, caller);
      case 'tasks/pushNotificationConfig/delete':
        return this.handleDeletePushNotificationConfig(params, caller);
      case 'agent/getAuthenticatedExtendedCard':
        return this.handleExtendedCard(params, options);
      default:
        throw new A2AError(errors.methodNotFound(method));
    }
  }

  private async handleSendMessage(
    rawParams: unknown,
    caller: A2ACaller | undefined,
    options: A2AHandleOptions | undefined
  ): Promise<A2ATask> {
    const params = parseMessageSendParams(rawParams);
    const { agent } = this.resolveAgent(params, options);
    const { message, configuration } = params;
    this.validateInitialPushConfig(configuration);

    const task = await this.startTask(params, caller);
    const execution = this.taskManager.executeTask(task, this.cogitator, agent, message, {
      timeout: this.runTimeout(agent, configuration?.timeout),
      ...(caller && { userId: caller.userId }),
    });

    if (configuration?.blocking === false) {
      execution.catch((error: unknown) => {
        console.error(`[a2a] Background task ${task.id} failed:`, error);
      });
      return this.shapeTask(task, configuration);
    }

    return this.shapeTask(await execution, configuration);
  }

  private validateInitialPushConfig(configuration?: MessageSendConfiguration): void {
    const pushConfig = configuration?.pushNotificationConfig;
    if (pushConfig) this.assertWebhookAllowed(pushConfig.url);
  }

  private async registerInitialPushConfig(
    taskId: string,
    configuration?: MessageSendConfiguration
  ): Promise<void> {
    const pushConfig = configuration?.pushNotificationConfig;
    if (!pushConfig) return;
    try {
      await this.pushNotificationStore.create(taskId, pushConfig);
    } catch (error) {
      await this.taskManager.failTask(taskId, 'Failed to register push notification');
      throw error;
    }
  }

  private assertWebhookAllowed(webhookUrl: string): void {
    if (this.allowPrivateUrls) return;
    try {
      validateWebhookUrl(webhookUrl);
    } catch (e) {
      throw new A2AError(errors.invalidParams(e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * The task as the client receives it, with `historyLength` and `acceptedOutputModes` applied.
   */
  private shapeTask(
    task: A2ATask,
    configuration?: Pick<MessageSendConfiguration, 'historyLength' | 'acceptedOutputModes'>
  ): A2ATask {
    let shaped = publicTask(task);
    const historyLength = configuration?.historyLength;
    if (historyLength !== undefined) {
      const history = shaped.history ?? [];
      shaped = { ...shaped, history: historyLength === 0 ? [] : history.slice(-historyLength) };
    }
    const accepted = configuration?.acceptedOutputModes;
    if (accepted && accepted.length > 0) {
      shaped = {
        ...shaped,
        artifacts: (shaped.artifacts ?? []).filter((artifact) =>
          artifact.parts.some((part) => accepted.includes(partMimeType(part)))
        ),
      };
    }
    return shaped;
  }

  private async handleGetTask(params: unknown, caller: A2ACaller | undefined): Promise<A2ATask> {
    const { id, historyLength } = parseTaskQueryParams(params);
    return this.shapeTask(await this.visibleTask(id, caller), { historyLength });
  }

  private async handleCancelTask(params: unknown, caller: A2ACaller | undefined): Promise<A2ATask> {
    const { id } = parseTaskIdParams(params);
    await this.visibleTask(id, caller);
    return publicTask(await this.taskManager.cancelTask(id));
  }

  /** Cogitator extension `tasks/list`: the caller's tasks, newest first. */
  private async handleListTasks(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<{ tasks: A2ATask[] }> {
    const raw = parseListTasksParams(params);
    const filter: TaskFilter = {
      contextId: raw.contextId,
      state: raw.state,
      offset: raw.offset,
      limit: Math.min(raw.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT),
      visibleTo: caller?.userId ?? null,
    };
    const tasks = await this.taskManager.listTasks(filter);
    return { tasks: tasks.map(publicTask) };
  }

  private async handleSetPushNotificationConfig(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<TaskPushNotificationConfig> {
    const { taskId, pushNotificationConfig } = parseTaskPushNotificationConfig(params);
    this.assertWebhookAllowed(pushNotificationConfig.url);
    await this.visibleTask(taskId, caller);
    const stored = await this.pushNotificationStore.create(taskId, pushNotificationConfig);
    return { taskId, pushNotificationConfig: stored };
  }

  private async handleGetPushNotificationConfig(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<TaskPushNotificationConfig> {
    const { id, pushNotificationConfigId } = parseGetPushNotificationConfigParams(params);
    await this.visibleTask(id, caller);
    const config = pushNotificationConfigId
      ? await this.pushNotificationStore.get(id, pushNotificationConfigId)
      : ((await this.pushNotificationStore.list(id))[0] ?? null);
    if (!config) {
      throw new A2AError(errors.pushNotificationConfigNotFound(id, pushNotificationConfigId ?? id));
    }
    return { taskId: id, pushNotificationConfig: config };
  }

  private async handleListPushNotificationConfigs(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<TaskPushNotificationConfig[]> {
    const { id } = parseTaskIdParams(params);
    await this.visibleTask(id, caller);
    const configs = await this.pushNotificationStore.list(id);
    return configs.map((pushNotificationConfig) => ({ taskId: id, pushNotificationConfig }));
  }

  private async handleDeletePushNotificationConfig(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<null> {
    const { id, pushNotificationConfigId } = parseDeletePushNotificationConfigParams(params);
    await this.visibleTask(id, caller);
    await this.pushNotificationStore.delete(id, pushNotificationConfigId);
    return null;
  }

  private async handleExtendedCard(
    params: unknown,
    options: A2AHandleOptions | undefined
  ): Promise<AgentCard> {
    if (!this.extendedCardGenerator) {
      throw new A2AError(errors.authenticatedExtendedCardNotConfigured());
    }
    const requested =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as { agentName?: unknown }).agentName
        : undefined;
    const name =
      options?.agentName ?? (typeof requested === 'string' ? requested : this.defaultAgentName);
    if (!this.hasAgent(name)) throw new A2AError(errors.agentNotFound(name));
    return this.signed(this.extendedCardGenerator(name));
  }
}
