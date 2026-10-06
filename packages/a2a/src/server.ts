import { resolveSseHeartbeatMs } from '@cogitator-ai/server-shared';
import type { Agent as IAgent } from '@cogitator-ai/types';
import type {
  A2AServerConfig,
  AgentCard,
  ExtendedAgentCard,
  A2AMessage,
  A2ATask,
  A2AStreamEvent,
  TokenStreamEvent,
  SendMessageConfiguration,
  TaskFilter,
  CogitatorLike,
  PushNotificationConfig,
  PushNotificationStore,
  A2AAuthConfig,
  A2ACaller,
} from './types.js';
import type { JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';
import {
  parseJsonRpcRequest,
  createSuccessResponse,
  createErrorResponse,
  JsonRpcParseError,
} from './json-rpc.js';
import { TaskManager } from './task-manager.js';
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

type HeaderGetter = (name: string) => string | null | undefined;

const MAX_LIST_LIMIT = 1000;

interface SendMessageParams {
  message: A2AMessage;
  configuration?: SendMessageConfiguration;
  agentName?: string;
}

function failedStatusEvent(message: string, taskId = ''): A2AStreamEvent {
  const timestamp = new Date().toISOString();
  return {
    type: 'status-update',
    taskId,
    status: { state: 'failed', timestamp, message },
    timestamp,
  };
}

function isValidMessage(message: unknown): message is A2AMessage {
  if (!message || typeof message !== 'object') return false;
  const m = message as Partial<A2AMessage>;
  return (m.role === 'user' || m.role === 'agent') && Array.isArray(m.parts);
}

function assertOptionalNonNegativeInt(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new A2AError(errors.invalidParams(`${name} must be a non-negative integer`));
  }
}

export class A2AServer {
  private agents: Record<string, IAgent>;
  private cogitator: CogitatorLike;
  private taskManager: TaskManager;
  private agentCards: Map<string, AgentCard>;
  /** The path the framework adapters serve JSON-RPC on, and the cards advertise without `cardUrl`. */
  readonly basePath: string;
  /** How often the framework adapters write a heartbeat on an open stream; `0` for never */
  readonly sseHeartbeatMs: number;
  private cardUrl: string;
  private pushNotificationStore: PushNotificationStore;
  private pushSender: PushNotificationSender;
  private cardSigning?: AgentCardSigningOptions;
  private extendedCardGenerator?: (agentName: string) => ExtendedAgentCard;
  private allowPrivateUrls: boolean;
  private auth?: A2AAuthConfig;

  constructor(config: A2AServerConfig) {
    const agentNames = Object.keys(config.agents);
    if (agentNames.length === 0) {
      throw new Error('A2AServer requires at least one agent');
    }

    this.agents = config.agents;
    this.cogitator = config.cogitator;
    this.basePath = config.basePath ?? '/a2a';
    if (!this.basePath.startsWith('/')) {
      throw new Error(
        `A2AServer basePath must be a path starting with "/", got "${this.basePath}"`
      );
    }
    this.sseHeartbeatMs = resolveSseHeartbeatMs(config.sseHeartbeatMs);
    this.cardUrl = config.cardUrl ?? '';
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

    this.taskManager.on('event', (event: A2AStreamEvent) => {
      if (event.type === 'status-update' || event.type === 'artifact-update') {
        this.pushSender.notify(event.taskId, event).catch(() => {});
      }
    });

    const hasPushNotifications = !!config.pushNotificationStore;
    const hasExtendedCard = !!config.extendedCardGenerator;

    this.agentCards = new Map();
    for (const [name, agent] of Object.entries(this.agents)) {
      const card = generateAgentCard(agent, {
        url: this.cardUrl || this.basePath,
        capabilities: {
          streaming: true,
          pushNotifications: hasPushNotifications,
          extendedAgentCard: hasExtendedCard,
        },
      });
      if (this.auth) {
        const schemeName = this.auth.type === 'bearer' ? 'bearer' : 'apiKey';
        card.securitySchemes = {
          [schemeName]:
            this.auth.type === 'bearer'
              ? { type: 'http', scheme: 'bearer' }
              : {
                  type: 'apiKey',
                  location: 'header',
                  parameterName: this.auth.headerName ?? 'x-api-key',
                },
        };
        card.security = [{ [schemeName]: [] }];
      }
      this.agentCards.set(name, card);
    }
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

  getAgentCard(agentName?: string): AgentCard {
    let card: AgentCard;
    if (agentName) {
      const found = this.agentCards.get(agentName);
      if (!found) throw new A2AError(errors.agentNotFound(agentName));
      card = found;
    } else {
      card = this.agentCards.values().next().value!;
    }
    if (this.cardSigning) {
      return signAgentCard(card, this.cardSigning);
    }
    return card;
  }

  getAgentCards(): AgentCard[] {
    const cards = Array.from(this.agentCards.values());
    if (this.cardSigning) {
      return cards.map((c) => signAgentCard(c, this.cardSigning!));
    }
    return cards;
  }

  async handleJsonRpc(body: unknown, authToken?: string): Promise<JsonRpcResponse | null> {
    let request: JsonRpcRequest;
    try {
      const parsed = parseJsonRpcRequest(body);
      if (Array.isArray(parsed)) {
        return createErrorResponse(null, errors.invalidRequest('Batch requests are not supported'));
      }
      request = parsed;
    } catch (e) {
      if (e instanceof JsonRpcParseError) {
        return createErrorResponse(
          null,
          e.code === -32600 ? errors.invalidRequest(e.message) : errors.parseError(e.message)
        );
      }
      return createErrorResponse(null, errors.clientJsonRpcError(e, 'JSON-RPC parse error'));
    }

    let caller: A2ACaller | undefined;
    try {
      caller = await this.authenticate(authToken);
    } catch (e) {
      if (request.id === undefined) return null;
      return createErrorResponse(request.id, errors.clientJsonRpcError(e, 'Authentication error'));
    }

    try {
      const result = await this.routeMethod(request.method, request.params, caller);
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

  async *handleJsonRpcStream(
    body: unknown,
    authToken?: string,
    signal?: AbortSignal
  ): AsyncGenerator<A2AStreamEvent> {
    let request: JsonRpcRequest;
    try {
      const parsed = parseJsonRpcRequest(body);
      if (Array.isArray(parsed)) {
        yield failedStatusEvent('Batch requests are not supported');
        return;
      }
      request = parsed;
    } catch (e) {
      yield failedStatusEvent(errors.clientErrorMessage(e, 'JSON-RPC parse error'));
      return;
    }

    let caller: A2ACaller | undefined;
    try {
      caller = await this.authenticate(authToken);
    } catch (e) {
      yield failedStatusEvent(errors.clientErrorMessage(e, 'Authentication error'));
      return;
    }

    if (request.method !== 'message/stream') {
      yield failedStatusEvent(`Unsupported method for streaming: ${request.method}`);
      return;
    }

    const params = request.params as Partial<SendMessageParams> | undefined;
    if (!params || !isValidMessage(params.message)) {
      yield failedStatusEvent('Missing required parameter: message with role and parts');
      return;
    }
    const message = params.message;

    const agentName = params.agentName ?? Object.keys(this.agents)[0];
    const agent = this.agents[agentName];
    if (!agent) {
      yield failedStatusEvent(`Agent not found: ${agentName}`);
      return;
    }

    if (signal?.aborted) return;

    const eventQueue: A2AStreamEvent[] = [];
    let wake: (() => void) | null = null;
    const notify = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };
    let taskId: string | null = message.taskId ?? null;

    const onEvent = (event: A2AStreamEvent) => {
      if (taskId && event.taskId === taskId) {
        eventQueue.push(event);
        notify();
      }
    };
    let executingTaskId: string | null = null;
    const onAbort = () => {
      if (executingTaskId) this.taskManager.abortExecution(executingTaskId);
      notify();
    };

    this.taskManager.on('event', onEvent);
    signal?.addEventListener('abort', onAbort, { once: true });

    let executionPromise: Promise<unknown> | null = null;

    try {
      let task: A2ATask;
      const isContinued = !!message.taskId;
      try {
        this.validateInitialPushConfig(params.configuration);
        if (isContinued) {
          await this.visibleTask(message.taskId!, caller);
          task = await this.taskManager.continueTask(message.taskId!, message);
        } else {
          await this.assertContextAvailable(message.contextId, caller);
          task = await this.taskManager.createTask(message, message.contextId, caller?.userId);
          taskId = task.id;
          await this.registerInitialPushConfig(task.id, params.configuration);
        }
      } catch (error) {
        yield failedStatusEvent(
          errors.clientErrorMessage(error, 'message/stream failed'),
          taskId ?? ''
        );
        return;
      }

      const currentTaskId = task.id;
      const onToken = (token: string) => {
        const event: TokenStreamEvent = {
          type: 'token',
          taskId: currentTaskId,
          token,
          timestamp: new Date().toISOString(),
        };
        eventQueue.push(event);
        notify();
      };

      let executionDone = false;
      let executionError: unknown;
      executingTaskId = task.id;
      executionPromise = this.taskManager
        .executeTask(task, this.cogitator, agent, message, {
          onToken,
          timeout: params.configuration?.timeout,
          ...(caller && { userId: caller.userId }),
        })
        .then(
          () => {
            executionDone = true;
            notify();
          },
          (error: unknown) => {
            executionError = error;
            executionDone = true;
            notify();
          }
        );

      if (!isContinued) {
        yield {
          type: 'status-update',
          taskId: task.id,
          status: task.status,
          timestamp: new Date().toISOString(),
        };
      }

      while (!signal?.aborted) {
        const event = eventQueue.shift();
        if (event) {
          yield event;
          if (event.type === 'status-update' && isStreamFinalState(event.status.state)) {
            return;
          }
          continue;
        }

        if (executionDone) {
          if (executionError !== undefined) {
            yield failedStatusEvent(
              errors.clientErrorMessage(executionError, `Task ${task.id} failed`),
              task.id
            );
            return;
          }
          const finalTask = await this.taskManager.getTask(task.id);
          if (!isStreamFinalState(finalTask.status.state)) {
            yield failedStatusEvent('Execution ended without reaching a terminal state', task.id);
          }
          return;
        }

        await new Promise<void>((r) => {
          wake = r;
        });
      }
    } finally {
      this.taskManager.removeListener('event', onEvent);
      signal?.removeEventListener('abort', onAbort);
      if (executingTaskId) this.taskManager.abortExecution(executingTaskId);
      if (executionPromise) await executionPromise;
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

  private async routeMethod(
    method: string,
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<unknown> {
    switch (method) {
      case 'message/send':
        return this.handleSendMessage(params, caller);
      case 'message/stream':
        throw new A2AError(errors.unsupportedOperation('Use handleJsonRpcStream for streaming'));
      case 'tasks/get':
        return this.handleGetTask(params, caller);
      case 'tasks/cancel':
        return this.handleCancelTask(params, caller);
      case 'tasks/list':
        return this.handleListTasks(params, caller);
      case 'tasks/pushNotification/create':
        return this.handleCreatePushNotification(params, caller);
      case 'tasks/pushNotification/get':
        return this.handleGetPushNotification(params, caller);
      case 'tasks/pushNotification/list':
        return this.handleListPushNotifications(params, caller);
      case 'tasks/pushNotification/delete':
        return this.handleDeletePushNotification(params, caller);
      case 'agent/extendedCard':
        return this.handleExtendedCard(params);
      default:
        throw new A2AError(errors.methodNotFound(method));
    }
  }

  private async handleSendMessage(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<A2ATask> {
    const { message, agentName, configuration } = (params ?? {}) as Partial<SendMessageParams>;

    if (!isValidMessage(message)) {
      throw new A2AError(errors.invalidParams('message is required with role and parts'));
    }
    assertOptionalNonNegativeInt(configuration?.historyLength, 'configuration.historyLength');
    assertOptionalNonNegativeInt(configuration?.timeout, 'configuration.timeout');

    const resolvedAgentName = agentName ?? Object.keys(this.agents)[0];
    const agent = this.agents[resolvedAgentName];
    if (!agent) throw new A2AError(errors.agentNotFound(resolvedAgentName));

    this.validateInitialPushConfig(configuration);

    let task: A2ATask;
    if (message.taskId) {
      await this.visibleTask(message.taskId, caller);
      task = await this.taskManager.continueTask(message.taskId, message);
    } else {
      await this.assertContextAvailable(message.contextId, caller);
      task = await this.taskManager.createTask(message, message.contextId, caller?.userId);
      await this.registerInitialPushConfig(task.id, configuration);
    }

    const execution = this.taskManager.executeTask(task, this.cogitator, agent, message, {
      timeout: configuration?.timeout,
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

  private validateInitialPushConfig(configuration?: SendMessageConfiguration): void {
    const pushConfig = configuration?.pushNotificationConfig;
    if (!pushConfig) return;
    if (!pushConfig.webhookUrl) {
      throw new A2AError(errors.invalidParams('pushNotificationConfig.webhookUrl is required'));
    }
    this.assertWebhookAllowed(pushConfig.webhookUrl);
  }

  private async registerInitialPushConfig(
    taskId: string,
    configuration?: SendMessageConfiguration
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
   * Apply historyLength / acceptedOutputModes from the request configuration
   */
  private shapeTask(
    task: A2ATask,
    configuration?: Pick<SendMessageConfiguration, 'historyLength' | 'acceptedOutputModes'>
  ): A2ATask {
    let shaped = publicTask(task);
    const historyLength = configuration?.historyLength;
    if (historyLength !== undefined) {
      shaped = {
        ...shaped,
        history: historyLength === 0 ? [] : shaped.history.slice(-historyLength),
      };
    }
    const accepted = configuration?.acceptedOutputModes;
    if (accepted && accepted.length > 0) {
      shaped = {
        ...shaped,
        artifacts: shaped.artifacts.filter((a) => !a.mimeType || accepted.includes(a.mimeType)),
      };
    }
    return shaped;
  }

  private async handleGetTask(params: unknown, caller: A2ACaller | undefined): Promise<A2ATask> {
    const { id, historyLength } = (params ?? {}) as { id?: string; historyLength?: number };
    if (!id) throw new A2AError(errors.invalidParams('id is required'));
    assertOptionalNonNegativeInt(historyLength, 'historyLength');
    return this.shapeTask(await this.visibleTask(id, caller), { historyLength });
  }

  private async handleCancelTask(params: unknown, caller: A2ACaller | undefined): Promise<A2ATask> {
    const { id } = (params ?? {}) as { id?: string };
    if (!id) throw new A2AError(errors.invalidParams('id is required'));
    await this.visibleTask(id, caller);
    return publicTask(await this.taskManager.cancelTask(id));
  }

  private async handleListTasks(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<{ tasks: A2ATask[] }> {
    const raw = (params ?? {}) as TaskFilter;
    assertOptionalNonNegativeInt(raw.limit, 'limit');
    assertOptionalNonNegativeInt(raw.offset, 'offset');
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

  private async handleCreatePushNotification(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<PushNotificationConfig> {
    const { taskId, config } = (params ?? {}) as {
      taskId?: string;
      config?: PushNotificationConfig;
    };
    if (!taskId) throw new A2AError(errors.invalidParams('taskId is required'));
    if (!config?.webhookUrl)
      throw new A2AError(errors.invalidParams('config.webhookUrl is required'));
    this.assertWebhookAllowed(config.webhookUrl);
    await this.visibleTask(taskId, caller);
    return this.pushNotificationStore.create(taskId, config);
  }

  private async handleGetPushNotification(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<PushNotificationConfig | null> {
    const { taskId, configId } = (params ?? {}) as { taskId?: string; configId?: string };
    if (!taskId || !configId) {
      throw new A2AError(errors.invalidParams('taskId and configId are required'));
    }
    await this.visibleTask(taskId, caller);
    return this.pushNotificationStore.get(taskId, configId);
  }

  private async handleListPushNotifications(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<PushNotificationConfig[]> {
    const { taskId } = (params ?? {}) as { taskId?: string };
    if (!taskId) throw new A2AError(errors.invalidParams('taskId is required'));
    await this.visibleTask(taskId, caller);
    return this.pushNotificationStore.list(taskId);
  }

  private async handleDeletePushNotification(
    params: unknown,
    caller: A2ACaller | undefined
  ): Promise<{ success: boolean }> {
    const { taskId, configId } = (params ?? {}) as { taskId?: string; configId?: string };
    if (!taskId || !configId) {
      throw new A2AError(errors.invalidParams('taskId and configId are required'));
    }
    await this.visibleTask(taskId, caller);
    await this.pushNotificationStore.delete(taskId, configId);
    return { success: true };
  }

  private async handleExtendedCard(params: unknown): Promise<ExtendedAgentCard> {
    if (!this.extendedCardGenerator) {
      throw new A2AError(errors.unsupportedOperation('Extended agent card is not configured'));
    }
    const { agentName } = (params ?? {}) as { agentName?: string };
    const name = agentName ?? Object.keys(this.agents)[0];
    if (!this.agents[name]) throw new A2AError(errors.agentNotFound(name));
    return this.extendedCardGenerator(name);
  }
}
