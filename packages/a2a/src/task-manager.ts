import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  A2ATask,
  A2AMessage,
  TaskStore,
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

export type { CogitatorLike, AgentRunResult };

export interface TaskManagerConfig {
  taskStore?: TaskStore;
}

export class TaskManager extends EventEmitter {
  private store: TaskStore;
  private activeTasks = new Map<string, AbortController>();

  constructor(config?: TaskManagerConfig) {
    super();
    this.store = config?.taskStore ?? new InMemoryTaskStore();
  }

  async createTask(message: A2AMessage, contextId?: string): Promise<A2ATask> {
    const task: A2ATask = {
      id: `task_${randomUUID()}`,
      contextId: contextId ?? `ctx_${randomUUID()}`,
      status: { state: 'working', timestamp: new Date().toISOString() },
      history: [message],
      artifacts: [],
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
    onToken?: (token: string) => void
  ): Promise<A2ATask> {
    const abortController = new AbortController();
    this.activeTasks.set(task.id, abortController);

    try {
      const input = this.extractTextFromMessage(message);
      const result = await cogitator.run(agent, {
        input,
        signal: abortController.signal,
        stream: !!onToken,
        onToken,
      });
      return await this.completeTask(task.id, result);
    } catch (error) {
      if (abortController.signal.aborted) {
        const current = await this.store.get(task.id);
        if (current && isTerminalState(current.status.state)) {
          return current;
        }
        return await this.cancelTask(task.id);
      }
      return await this.failTask(task.id, error instanceof Error ? error.message : String(error));
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

    if (result.structured) {
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

    const history = [...existing.history, agentMessage];
    await this.store.update(taskId, { status, artifacts, history });

    const updatedTask = await this.store.get(taskId);
    if (!updatedTask) throw new A2AError(errors.taskNotFound(taskId));

    this.emitStatusUpdate(updatedTask);
    for (const artifact of artifacts) {
      this.emitArtifactUpdate(updatedTask.id, artifact);
    }

    return updatedTask;
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

  async getTask(taskId: string): Promise<A2ATask> {
    const task = await this.store.get(taskId);
    if (!task) throw new A2AError(errors.taskNotFound(taskId));
    return task;
  }

  private extractTextFromMessage(message: A2AMessage): string {
    return message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
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

    if (result.structured) {
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
