import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ToolApprovalRequest } from '@cogitator-ai/types';
import type {
  A2ATask,
  A2AMessage,
  Part,
  TaskStore,
  TaskFilter,
  TaskStatus,
  A2AStreamEvent,
  Artifact,
  CogitatorLike,
  AgentRunResult,
} from './types.js';
import { InMemoryTaskStore } from './task-store.js';
import { isTerminalState } from './types.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { TASK_OWNER_KEY } from './ownership.js';
import {
  TASK_PENDING_APPROVALS_KEY,
  readToolApprovalResponse,
  taskPendingApprovals,
  toolApprovalRequestPart,
} from './approvals.js';

export interface TaskManagerConfig {
  taskStore?: TaskStore;
}

export interface ExecuteTaskOptions {
  /** Called for every streamed token */
  onToken?: (token: string) => void;
  /** Maximum agent run time in ms */
  timeout?: number;
  /** The caller the run acts for */
  userId?: string;
}

const CONTINUABLE_STATES: readonly string[] = ['input-required', 'completed'];

export class TaskManager extends EventEmitter {
  private store: TaskStore;
  private activeTasks = new Map<string, AbortController>();
  private continuing = new Set<string>();

  constructor(config?: TaskManagerConfig) {
    super();
    this.setMaxListeners(100);
    this.store = config?.taskStore ?? new InMemoryTaskStore();
  }

  /** A new task; `ownerId` keeps it visible only to that user. */
  async createTask(message: A2AMessage, contextId?: string, ownerId?: string): Promise<A2ATask> {
    const task: A2ATask = {
      id: `task_${randomUUID()}`,
      contextId: contextId ?? `ctx_${randomUUID()}`,
      status: { state: 'working', timestamp: new Date().toISOString() },
      history: [message],
      artifacts: [],
      ...(ownerId !== undefined && { metadata: { [TASK_OWNER_KEY]: ownerId } }),
    };
    await this.store.create(task);
    this.emitStatusUpdate(task);
    return task;
  }

  async executeTask(
    task: A2ATask,
    cogitator: CogitatorLike,
    agent: unknown,
    message: A2AMessage,
    onTokenOrOptions?: ((token: string) => void) | ExecuteTaskOptions
  ): Promise<A2ATask> {
    const options: ExecuteTaskOptions =
      typeof onTokenOrOptions === 'function'
        ? { onToken: onTokenOrOptions }
        : (onTokenOrOptions ?? {});
    const abortController = new AbortController();
    this.activeTasks.set(task.id, abortController);

    try {
      const decisions = taskPendingApprovals(task) && readToolApprovalResponse(message);
      let result: AgentRunResult;
      if (decisions) {
        if (!cogitator.resume) {
          throw new A2AError(
            errors.unsupportedOperation(
              'resuming a run paused for tool approvals (the server Cogitator has no resume)'
            )
          );
        }
        result = await cogitator.resume(agent, task.contextId, {
          ...decisions,
          signal: abortController.signal,
          stream: !!options.onToken,
          onToken: options.onToken,
          timeout: options.timeout,
          ...(options.userId !== undefined && { userId: options.userId }),
        });
      } else {
        const priorHistory = this.historyBefore(task.history, message);
        result = await cogitator.run(agent, {
          input: this.buildInput(priorHistory, message),
          signal: abortController.signal,
          stream: !!options.onToken,
          onToken: options.onToken,
          threadId: task.contextId,
          timeout: options.timeout,
          ...(options.userId !== undefined && { userId: options.userId }),
          ...(priorHistory.length > 0 && { loadHistory: false }),
        });
      }

      if (result.status === 'paused') {
        return await this.requestApproval(task.id, result);
      }

      if (result.requiresInput) {
        return await this.requestInput(task.id, result);
      }

      return await this.completeTask(task.id, result);
    } catch (error) {
      if (abortController.signal.aborted) {
        const current = await this.store.get(task.id);
        if (current && isTerminalState(current.status.state)) {
          return current;
        }
        return await this.cancelTask(task.id);
      }
      return await this.failTask(
        task.id,
        errors.clientErrorMessage(error, `Task ${task.id} failed`)
      );
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  async completeTask(taskId: string, result: AgentRunResult): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));

    const artifacts = this.buildArtifacts(result);
    const agentMessage: A2AMessage = {
      role: 'agent',
      parts: [{ type: 'text', text: result.output }],
      taskId,
    };

    if (
      result.structured &&
      typeof result.structured === 'object' &&
      !Array.isArray(result.structured)
    ) {
      agentMessage.parts.push({
        type: 'data',
        mimeType: 'application/json',
        data: result.structured as Record<string, unknown>,
      });
    }

    const status: TaskStatus = {
      state: 'completed',
      timestamp: new Date().toISOString(),
    };

    return this.finishTurn(existing, status, agentMessage, artifacts);
  }

  async failTask(taskId: string, errorMessage: string): Promise<A2ATask> {
    const status: TaskStatus = {
      state: 'failed',
      timestamp: new Date().toISOString(),
      message: errorMessage,
      errorDetails: { code: -1, message: errorMessage },
    };

    await this.store.update(taskId, { status });
    const task = await this.store.get(taskId);
    if (!task) throw new A2AError(errors.taskNotFound(taskId));
    this.emitStatusUpdate(task);
    return task;
  }

  async cancelTask(taskId: string): Promise<A2ATask> {
    const task = await this.store.get(taskId);
    if (!task) throw new A2AError(errors.taskNotFound(taskId));
    if (isTerminalState(task.status.state)) {
      throw new A2AError(errors.taskNotCancelable(taskId));
    }

    const controller = this.activeTasks.get(taskId);
    if (controller) controller.abort();

    const rechecked = await this.store.get(taskId);
    if (!rechecked) throw new A2AError(errors.taskNotFound(taskId));
    if (isTerminalState(rechecked.status.state)) {
      return rechecked;
    }

    const status: TaskStatus = {
      state: 'canceled',
      timestamp: new Date().toISOString(),
    };
    await this.store.update(taskId, { status });

    const updated = await this.store.get(taskId);
    if (!updated) throw new A2AError(errors.taskNotFound(taskId));
    this.emitStatusUpdate(updated);
    return updated;
  }

  async continueTask(taskId: string, message: A2AMessage): Promise<A2ATask> {
    if (this.continuing.has(taskId) || this.activeTasks.has(taskId)) {
      throw new A2AError(errors.taskNotContinuable(taskId, 'working'));
    }
    this.continuing.add(taskId);

    try {
      const task = await this.store.get(taskId);
      if (!task) throw new A2AError(errors.taskNotFound(taskId));

      if (!CONTINUABLE_STATES.includes(task.status.state)) {
        throw new A2AError(errors.taskNotContinuable(taskId, task.status.state));
      }

      const history = [...task.history, { ...message, taskId, contextId: task.contextId }];
      const status: TaskStatus = {
        state: 'working',
        timestamp: new Date().toISOString(),
      };

      await this.store.update(taskId, { history, status });
      const updated = await this.store.get(taskId);
      if (!updated) throw new A2AError(errors.taskNotFound(taskId));

      this.emitStatusUpdate(updated);
      return updated;
    } finally {
      this.continuing.delete(taskId);
    }
  }

  abortExecution(taskId: string): void {
    const controller = this.activeTasks.get(taskId);
    if (controller) controller.abort();
  }

  async listTasks(filter?: TaskFilter): Promise<A2ATask[]> {
    return this.store.list(filter);
  }

  async getTask(taskId: string): Promise<A2ATask> {
    const task = await this.store.get(taskId);
    if (!task) throw new A2AError(errors.taskNotFound(taskId));
    return task;
  }

  /**
   * History preceding the message being executed (the message itself is the
   * last history entry for both new and continued tasks).
   */
  private historyBefore(history: A2AMessage[], message: A2AMessage): A2AMessage[] {
    const last = history.at(-1);
    return last?.role === message.role ? history.slice(0, -1) : history;
  }

  /**
   * Build the agent input. Continuations replay the task transcript so the
   * agent keeps the conversation context even without a memory adapter.
   */
  private buildInput(priorHistory: A2AMessage[], message: A2AMessage): string {
    const current = this.renderParts(message.parts);
    if (priorHistory.length === 0) {
      return current;
    }

    const transcript = priorHistory
      .map((m) => `${m.role === 'agent' ? 'Agent' : 'User'}: ${this.renderParts(m.parts)}`)
      .join('\n\n');

    return `Conversation so far:\n\n${transcript}\n\nUser: ${current}`;
  }

  private renderParts(parts: Part[]): string {
    return parts
      .map((part) => {
        switch (part.type) {
          case 'text':
            return part.text;
          case 'data':
            return `\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``;
          case 'file':
            return `[file${part.name ? ` ${part.name}` : ''} (${part.mimeType}): ${part.uri}]`;
        }
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }

  private buildArtifacts(result: AgentRunResult): Artifact[] {
    const artifacts: Artifact[] = [];

    if (result.output) {
      artifacts.push({
        id: `art_${randomUUID()}`,
        parts: [{ type: 'text', text: result.output }],
        mimeType: 'text/plain',
      });
    }

    if (
      result.structured &&
      typeof result.structured === 'object' &&
      !Array.isArray(result.structured)
    ) {
      artifacts.push({
        id: `art_${randomUUID()}`,
        parts: [
          {
            type: 'data',
            mimeType: 'application/json',
            data: result.structured as Record<string, unknown>,
          },
        ],
        mimeType: 'application/json',
      });
    }

    return artifacts;
  }

  /**
   * A run that paused for tool approvals: the task waits in `input-required`, its agent message
   * carries the calls in a tool approval request data part, and the client's decisions (a tool
   * approval response data part in the message that continues the task) resume the run.
   */
  private async requestApproval(taskId: string, result: AgentRunResult): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));

    const pending = result.pendingApprovals ?? [];
    const calls = pending.map((approval) => approval.toolName).join(', ') || 'tool calls';
    const agentMessage: A2AMessage = {
      role: 'agent',
      parts: [
        ...(result.output ? [{ type: 'text' as const, text: result.output }] : []),
        toolApprovalRequestPart(pending),
      ],
      taskId,
    };
    const status: TaskStatus = {
      state: 'input-required',
      timestamp: new Date().toISOString(),
      message: `Waiting for approval of ${calls}`,
    };

    return this.finishTurn(existing, status, agentMessage, [], pending);
  }

  /**
   * The metadata update that records the calls a task waits on, or drops the record once the
   * task stopped waiting; nothing when there is nothing to change.
   */
  private withPendingApprovals(
    task: A2ATask,
    pending: readonly ToolApprovalRequest[] | undefined
  ): Pick<A2ATask, 'metadata'> | Record<string, never> {
    const metadata = { ...task.metadata };
    if (pending && pending.length > 0) {
      metadata[TASK_PENDING_APPROVALS_KEY] = pending.map((approval) => ({ ...approval }));
    } else if (TASK_PENDING_APPROVALS_KEY in metadata) {
      delete metadata[TASK_PENDING_APPROVALS_KEY];
    } else {
      return {};
    }
    return { metadata };
  }

  private async requestInput(taskId: string, result: AgentRunResult): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));

    const artifacts = this.buildArtifacts(result);
    const agentMessage: A2AMessage = {
      role: 'agent',
      parts: [{ type: 'text', text: result.output }],
      taskId,
    };

    const status: TaskStatus = {
      state: 'input-required',
      timestamp: new Date().toISOString(),
      message: result.output || undefined,
    };

    return this.finishTurn(existing, status, agentMessage, artifacts);
  }

  /**
   * Persist the outcome of an agent turn. Artifacts accumulate across turns,
   * and artifact events are emitted before the status event so streaming
   * consumers (which stop at the final status) never miss them.
   */
  private async finishTurn(
    existing: A2ATask,
    status: TaskStatus,
    agentMessage: A2AMessage,
    newArtifacts: Artifact[],
    pendingApprovals?: readonly ToolApprovalRequest[]
  ): Promise<A2ATask> {
    await this.store.update(existing.id, {
      status,
      artifacts: [...(existing.artifacts ?? []), ...newArtifacts],
      history: [...existing.history, agentMessage],
      ...this.withPendingApprovals(existing, pendingApprovals),
    });

    const updatedTask = await this.store.get(existing.id);
    if (!updatedTask) throw new A2AError(errors.taskNotFound(existing.id));

    for (const artifact of newArtifacts) {
      this.emitArtifactUpdate(updatedTask.id, artifact);
    }
    this.emitStatusUpdate(updatedTask);

    return updatedTask;
  }

  private emitStatusUpdate(task: A2ATask): void {
    const event: A2AStreamEvent = {
      type: 'status-update',
      taskId: task.id,
      status: task.status,
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }

  private emitArtifactUpdate(taskId: string, artifact: Artifact): void {
    const event: A2AStreamEvent = {
      type: 'artifact-update',
      taskId,
      artifact,
      timestamp: new Date().toISOString(),
    };
    this.emit('event', event);
  }
}
