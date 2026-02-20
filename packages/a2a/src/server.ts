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
import { InMemoryPushNotificationStore, PushNotificationSender } from './push-notifications.js';
import { isTerminalState } from './types.js';

export class A2AServer {
  private agents: Record<string, IAgent>;
  private cogitator: CogitatorLike;
  private taskManager: TaskManager;
  private agentCards: Map<string, AgentCard>;
  private basePath: string;
  private cardUrl: string;
  private pushNotificationStore: PushNotificationStore;
  private pushSender: PushNotificationSender;
  private cardSigning?: AgentCardSigningOptions;
  private extendedCardGenerator?: (agentName: string) => ExtendedAgentCard;

  constructor(config: A2AServerConfig) {
    const agentNames = Object.keys(config.agents);
    if (agentNames.length === 0) {
      throw new Error('A2AServer requires at least one agent');
    }

    this.agents = config.agents;
    this.cogitator = config.cogitator;
    this.basePath = config.basePath ?? '/a2a';
    this.cardUrl = config.cardUrl ?? '';
    this.cardSigning = config.cardSigning;
    this.extendedCardGenerator = config.extendedCardGenerator;

    this.pushNotificationStore =
      config.pushNotificationStore ?? new InMemoryPushNotificationStore();
    this.pushSender = new PushNotificationSender(this.pushNotificationStore);

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
          extendedAgentCard: hasExtendedCard || undefined,
        },
      });
      this.agentCards.set(name, card);
    }
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

  async handleJsonRpc(body: unknown): Promise<JsonRpcResponse> {
    let request: JsonRpcRequest;
    try {
      const parsed = parseJsonRpcRequest(body);
      if (Array.isArray(parsed)) {
        return createErrorResponse(null, errors.invalidRequest('Batch requests are not supported'));
      }
      request = parsed;
    } catch (e) {
      if (e instanceof JsonRpcParseError) {
        return createErrorResponse(null, errors.parseError(e.message));
      }
      return createErrorResponse(null, errors.internalError(String(e)));
    }

    try {
      const result = await this.routeMethod(request.method, request.params);
      return createSuccessResponse(request.id, result);
    } catch (e) {
      if (e instanceof A2AError) {
        return createErrorResponse(request.id, e.jsonRpcError);
      }
      return createErrorResponse(
        request.id,
        errors.internalError(e instanceof Error ? e.message : String(e))
      );
    }
  }

  async *handleJsonRpcStream(body: unknown): AsyncGenerator<A2AStreamEvent> {
    let request: JsonRpcRequest;
    try {
      const parsed = parseJsonRpcRequest(body);
      if (Array.isArray(parsed)) {
        yield {
          type: 'status-update',
          taskId: '',
          status: {
            state: 'failed',
            timestamp: new Date().toISOString(),
            message: 'Batch requests are not supported',
          },
          timestamp: new Date().toISOString(),
        };
        return;
      }
      request = parsed;
    } catch (e) {
      yield {
        type: 'status-update',
        taskId: '',
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: e instanceof Error ? e.message : 'Invalid JSON-RPC request',
        },
        timestamp: new Date().toISOString(),
      };
      return;
    }

    if (request.method !== 'message/stream') {
      yield {
        type: 'status-update',
        taskId: '',
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: `Unsupported method for streaming: ${request.method}`,
        },
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const params = request.params as
      | { message: A2AMessage; configuration?: SendMessageConfiguration; agentName?: string }
      | undefined;
    if (!params?.message) {
      yield {
        type: 'status-update',
        taskId: '',
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: 'Missing required parameter: message',
        },
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const agentName = params.agentName ?? Object.keys(this.agents)[0];
    const agent = this.agents[agentName];
    if (!agent) {
      yield {
        type: 'status-update',
        taskId: '',
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: `Agent not found: ${agentName}`,
        },
        timestamp: new Date().toISOString(),
      };
      return;
    }

    let task: A2ATask;
    if (params.message.taskId) {
      task = await this.taskManager.continueTask(params.message.taskId, params.message);
    } else {
      task = await this.taskManager.createTask(params.message, params.message.contextId);
    }

    const eventQueue: A2AStreamEvent[] = [];
    let resolve: (() => void) | null = null;

    const onEvent = (event: A2AStreamEvent) => {
      if (event.taskId === task.id) {
        eventQueue.push(event);
        if (resolve) {
          resolve();
          resolve = null;
        }
      }
    };

    this.taskManager.on('event', onEvent);

    const onToken = (token: string) => {
      const event: TokenStreamEvent = {
        type: 'token',
        taskId: task.id,
        token,
        timestamp: new Date().toISOString(),
      };
      eventQueue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    let executionDone = false;
    const executionPromise = this.taskManager
      .executeTask(task, this.cogitator, agent, params.message, onToken)
      .then(() => {
        executionDone = true;
        if (resolve) {
          resolve();
          resolve = null;
        }
      });

    try {
      yield {
        type: 'status-update',
        taskId: task.id,
        status: task.status,
        timestamp: new Date().toISOString(),
      };

      let done = false;
      while (!done) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          yield event;
          if (event.type === 'status-update' && isTerminalState(event.status.state)) {
            done = true;
          }
        } else if (executionDone) {
          const finalTask = await this.taskManager.getTask(task.id);
          if (isTerminalState(finalTask.status.state)) {
            done = true;
          }
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    } finally {
      this.taskManager.removeListener('event', onEvent);
      await executionPromise.catch(() => {});
    }
  }

  private async routeMethod(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'message/send':
        return this.handleSendMessage(params);
      case 'message/stream':
        throw new A2AError(errors.unsupportedOperation('Use handleJsonRpcStream for streaming'));
      case 'tasks/get':
        return this.handleGetTask(params);
      case 'tasks/cancel':
        return this.handleCancelTask(params);
      case 'tasks/list':
        return this.handleListTasks(params);
      case 'tasks/pushNotification/create':
        return this.handleCreatePushNotification(params);
      case 'tasks/pushNotification/get':
        return this.handleGetPushNotification(params);
      case 'tasks/pushNotification/list':
        return this.handleListPushNotifications(params);
      case 'tasks/pushNotification/delete':
        return this.handleDeletePushNotification(params);
      case 'agent/extendedCard':
        return this.handleExtendedCard(params);
      default:
        throw new A2AError(errors.methodNotFound(method));
    }
  }

  private async handleSendMessage(params: unknown): Promise<A2ATask> {
    const { message, agentName } = params as {
      message: A2AMessage;
      configuration?: SendMessageConfiguration;
      agentName?: string;
    };

    if (!message?.parts || !message.role) {
      throw new A2AError(errors.invalidParams('message is required with role and parts'));
    }

    const resolvedAgentName = agentName ?? Object.keys(this.agents)[0];
    const agent = this.agents[resolvedAgentName];
    if (!agent) throw new A2AError(errors.agentNotFound(resolvedAgentName));

    if (message.taskId) {
      const task = await this.taskManager.continueTask(message.taskId, message);
      return await this.taskManager.executeTask(task, this.cogitator, agent, message);
    }

    const task = await this.taskManager.createTask(message, message.contextId);
    return await this.taskManager.executeTask(task, this.cogitator, agent, message);
  }

  private async handleGetTask(params: unknown): Promise<A2ATask> {
    const { id } = params as { id: string };
    if (!id) throw new A2AError(errors.invalidParams('id is required'));
    return this.taskManager.getTask(id);
  }

  private async handleCancelTask(params: unknown): Promise<A2ATask> {
    const { id } = params as { id: string };
    if (!id) throw new A2AError(errors.invalidParams('id is required'));
    return this.taskManager.cancelTask(id);
  }

  private async handleListTasks(params: unknown): Promise<{ tasks: A2ATask[] }> {
    const filter = (params ?? {}) as TaskFilter;
    const tasks = await this.taskManager.listTasks(filter);
    return { tasks };
  }

  private async handleCreatePushNotification(params: unknown): Promise<PushNotificationConfig> {
    const { taskId, config } = params as { taskId: string; config: PushNotificationConfig };
    if (!taskId) throw new A2AError(errors.invalidParams('taskId is required'));
    if (!config?.webhookUrl)
      throw new A2AError(errors.invalidParams('config.webhookUrl is required'));
    return this.pushNotificationStore.create(taskId, config);
  }

  private async handleGetPushNotification(params: unknown): Promise<PushNotificationConfig | null> {
    const { taskId, configId } = params as { taskId: string; configId: string };
    if (!taskId || !configId) {
      throw new A2AError(errors.invalidParams('taskId and configId are required'));
    }
    return this.pushNotificationStore.get(taskId, configId);
  }

  private async handleListPushNotifications(params: unknown): Promise<PushNotificationConfig[]> {
    const { taskId } = params as { taskId: string };
    if (!taskId) throw new A2AError(errors.invalidParams('taskId is required'));
    return this.pushNotificationStore.list(taskId);
  }

  private async handleDeletePushNotification(params: unknown): Promise<{ success: boolean }> {
    const { taskId, configId } = params as { taskId: string; configId: string };
    if (!taskId || !configId) {
      throw new A2AError(errors.invalidParams('taskId and configId are required'));
    }
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
