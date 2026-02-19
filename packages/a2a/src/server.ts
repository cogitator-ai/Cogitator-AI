import type { Agent as IAgent } from '@cogitator-ai/types';
import type {
  A2AServerConfig,
  AgentCard,
  A2AMessage,
  A2ATask,
  A2AStreamEvent,
  SendMessageConfiguration,
  CogitatorLike,
} from './types.js';
import type { JsonRpcRequest, JsonRpcResponse } from './json-rpc.js';
import {
  parseJsonRpcRequest,
  createSuccessResponse,
  createErrorResponse,
  JsonRpcParseError,
} from './json-rpc.js';
import { TaskManager } from './task-manager.js';
import { generateAgentCard } from './agent-card.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { InMemoryTaskStore } from './task-store.js';
import { isTerminalState } from './types.js';

export class A2AServer {
  private agents: Record<string, IAgent>;
  private cogitator: CogitatorLike;
  private taskManager: TaskManager;
  private agentCards: Map<string, AgentCard>;
  private basePath: string;
  private cardUrl: string;

  constructor(config: A2AServerConfig) {
    const agentNames = Object.keys(config.agents);
    if (agentNames.length === 0) {
      throw new Error('A2AServer requires at least one agent');
    }

    this.agents = config.agents;
    this.cogitator = config.cogitator;
    this.basePath = config.basePath ?? '/a2a';
    this.cardUrl = config.cardUrl ?? '';

    this.taskManager = new TaskManager({
      taskStore: config.taskStore ?? new InMemoryTaskStore(),
    });

    this.agentCards = new Map();
    for (const [name, agent] of Object.entries(this.agents)) {
      const card = generateAgentCard(agent, {
        url: this.cardUrl || this.basePath,
        capabilities: { streaming: true, pushNotifications: false },
      });
      this.agentCards.set(name, card);
    }
  }

  getAgentCard(agentName?: string): AgentCard {
    if (agentName) {
      const card = this.agentCards.get(agentName);
      if (!card) throw new A2AError(errors.agentNotFound(agentName));
      return card;
    }
    return this.agentCards.values().next().value!;
  }

  getAgentCards(): AgentCard[] {
    return Array.from(this.agentCards.values());
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

    const task = await this.taskManager.createTask(params.message);

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

    let executionDone = false;
    const executionPromise = this.taskManager
      .executeTask(task, this.cogitator, agent, params.message)
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

    if (!message || !message.parts || !message.role) {
      throw new A2AError(errors.invalidParams('message is required with role and parts'));
    }

    const resolvedAgentName = agentName ?? Object.keys(this.agents)[0];
    const agent = this.agents[resolvedAgentName];
    if (!agent) throw new A2AError(errors.agentNotFound(resolvedAgentName));

    const task = await this.taskManager.createTask(message);
    const completed = await this.taskManager.executeTask(task, this.cogitator, agent, message);
    return completed;
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
}
