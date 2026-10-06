import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ToolApprovalRequest } from '@cogitator-ai/types';
import type {
  A2ATask,
  A2AMessage,
  Part,
  TaskStore,
  TaskFilter,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Artifact,
  CogitatorLike,
  AgentRunResult,
} from './types.js';
import { InMemoryTaskStore } from './task-store.js';
import { isStreamFinalState, isTerminalState } from './types.js';
import { A2AError } from './errors.js';
import * as errors from './errors.js';
import { TASK_CREATED_AT_KEY, TASK_OWNER_KEY, taskCreatedAt } from './ownership.js';
import {
  TASK_PENDING_APPROVALS_KEY,
  readToolApprovalResponse,
  taskPendingApprovals,
  toolApprovalRequestPart,
} from './approvals.js';
import { agentMessage, newArtifactId, textPart } from './protocol.js';

export interface TaskManagerConfig {
  taskStore?: TaskStore;
}

export interface ExecuteTaskOptions {
  /** Emit the reply as `artifact-update` chunks while the agent writes it */
  stream?: boolean;
  /** Called for every streamed token */
  onToken?: (token: string) => void;
  /** Maximum agent run time in ms */
  timeout?: number;
  /** The caller the run acts for */
  userId?: string;
}

/** What the task manager emits on `event`: the task changes a stream or a webhook relays. */
export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/** States a task takes a new message in: those where it waits on the client. */
const CONTINUABLE_STATES: readonly TaskState[] = ['input-required', 'auth-required'];

/**
 * Streams the reply of a run as chunks of one artifact. The last token is held back, so the
 * chunk that completes the artifact (`lastChunk`) still carries content, and when the final reply
 * differs from what was streamed (text the model wrote before a tool call, for instance) the
 * closing chunk replaces the artifact with the reply instead.
 */
class ReplyStreamer {
  readonly artifactId = newArtifactId();
  private sent = '';
  private pending: string | undefined;
  private chunks = 0;

  constructor(private readonly emitChunk: (event: TaskArtifactUpdateEvent) => void) {}

  get started(): boolean {
    return this.pending !== undefined;
  }

  push(task: Pick<A2ATask, 'id' | 'contextId'>, token: string): void {
    if (!token) return;
    if (this.pending !== undefined) {
      this.emitChunk(this.chunk(task, this.pending, false));
      this.sent += this.pending;
      this.chunks++;
    }
    this.pending = token;
  }

  /** The chunk that completes the reply artifact. */
  finish(task: Pick<A2ATask, 'id' | 'contextId'>, output: string): TaskArtifactUpdateEvent {
    const pending = this.pending ?? '';
    if (this.sent + pending === output) return this.chunk(task, pending, true);
    return {
      kind: 'artifact-update',
      taskId: task.id,
      contextId: task.contextId,
      artifact: { artifactId: this.artifactId, parts: [textPart(output)] },
      append: false,
      lastChunk: true,
    };
  }

  private chunk(
    task: Pick<A2ATask, 'id' | 'contextId'>,
    text: string,
    lastChunk: boolean
  ): TaskArtifactUpdateEvent {
    return {
      kind: 'artifact-update',
      taskId: task.id,
      contextId: task.contextId,
      artifact: { artifactId: this.artifactId, parts: [textPart(text)] },
      ...(this.chunks > 0 && { append: true }),
      lastChunk,
    };
  }
}

export class TaskManager extends EventEmitter {
  private store: TaskStore;
  private activeTasks = new Map<string, AbortController>();
  private continuing = new Set<string>();

  constructor(config?: TaskManagerConfig) {
    super();
    this.setMaxListeners(100);
    this.store = config?.taskStore ?? new InMemoryTaskStore();
  }

  /** A new `submitted` task; `ownerId` keeps it visible only to that user. */
  async createTask(message: A2AMessage, contextId?: string, ownerId?: string): Promise<A2ATask> {
    const id = `task_${randomUUID()}`;
    const resolvedContextId = contextId ?? `ctx_${randomUUID()}`;
    const now = new Date().toISOString();
    const task: A2ATask = {
      kind: 'task',
      id,
      contextId: resolvedContextId,
      status: { state: 'submitted', timestamp: now },
      history: [{ ...message, taskId: id, contextId: resolvedContextId }],
      artifacts: [],
      metadata: {
        [TASK_CREATED_AT_KEY]: now,
        ...(ownerId !== undefined && { [TASK_OWNER_KEY]: ownerId }),
      },
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
    const streamer = options.stream ? new ReplyStreamer((event) => this.emitEvent(event)) : null;
    const onToken =
      streamer || options.onToken
        ? (token: string) => {
            options.onToken?.(token);
            streamer?.push(task, token);
          }
        : undefined;

    try {
      if (task.status.state !== 'working') {
        await this.setStatus(task.id, { state: 'working', timestamp: new Date().toISOString() });
      }
      abortController.signal.throwIfAborted();

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
          stream: !!onToken,
          onToken,
          timeout: options.timeout,
          ...(options.userId !== undefined && { userId: options.userId }),
        });
      } else {
        const priorHistory = await this.priorHistory(task, message);
        result = await cogitator.run(agent, {
          input: this.buildInput(priorHistory, message),
          signal: abortController.signal,
          stream: !!onToken,
          onToken,
          threadId: task.contextId,
          timeout: options.timeout,
          ...(options.userId !== undefined && { userId: options.userId }),
          ...(priorHistory.length > 0 && { loadHistory: false }),
        });
      }

      if (result.status === 'paused') {
        return await this.requestApproval(task.id, result, streamer);
      }

      if (result.requiresInput) {
        return await this.requestInput(task.id, result, streamer);
      }

      return await this.completeTask(task.id, result, streamer);
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

  async completeTask(
    taskId: string,
    result: AgentRunResult,
    streamer?: ReplyStreamer | null
  ): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));

    const reply = agentMessage(existing, [textPart(result.output)]);
    const structured = this.structuredOutput(result);
    if (structured) reply.parts.push({ kind: 'data', data: structured });

    const status: TaskStatus = {
      state: 'completed',
      message: reply,
      timestamp: new Date().toISOString(),
    };

    return this.finishTurn(existing, status, reply, result, streamer);
  }

  async failTask(taskId: string, errorMessage: string): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));
    const status: TaskStatus = {
      state: 'failed',
      message: agentMessage(existing, [textPart(errorMessage)]),
      timestamp: new Date().toISOString(),
    };
    return this.setStatus(taskId, status);
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

    return this.setStatus(taskId, { state: 'canceled', timestamp: new Date().toISOString() });
  }

  /**
   * Add the client's answer to a task waiting on it (`input-required` or `auth-required`) and set
   * it working again. A task in a terminal state can't be restarted: the client sends a new
   * message in the same context instead.
   */
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

      const history = [...(task.history ?? []), { ...message, taskId, contextId: task.contextId }];
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

  /** Whether the task's run is executing in this process. */
  isExecuting(taskId: string): boolean {
    return this.activeTasks.has(taskId);
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
   * The conversation before the message being executed: the earlier turns of the task, or for a
   * new task in a context that already has tasks, their transcripts in the order they were
   * created. The agent keeps the context even without a memory adapter.
   */
  private async priorHistory(task: A2ATask, message: A2AMessage): Promise<A2AMessage[]> {
    const history = task.history ?? [];
    const last = history.at(-1);
    const before =
      last?.messageId === message.messageId || last?.role === message.role
        ? history.slice(0, -1)
        : history;
    if (before.length > 0) return before;

    const earlier = (await this.store.list({ contextId: task.contextId }))
      .filter((other) => other.id !== task.id)
      .sort((a, b) => taskCreatedAt(a) - taskCreatedAt(b));
    return earlier.flatMap((other) => other.history ?? []);
  }

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
        switch (part.kind) {
          case 'text':
            return part.text;
          case 'data':
            return `\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``;
          case 'file': {
            const { file } = part;
            const label = `file${file.name ? ` ${file.name}` : ''} (${file.mimeType ?? 'application/octet-stream'})`;
            return 'uri' in file
              ? `[${label}: ${file.uri}]`
              : `[${label}: ${Math.floor((file.bytes.length * 3) / 4)} bytes inline]`;
          }
        }
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }

  private structuredOutput(result: AgentRunResult): Record<string, unknown> | undefined {
    const { structured } = result;
    return structured && typeof structured === 'object' && !Array.isArray(structured)
      ? (structured as Record<string, unknown>)
      : undefined;
  }

  /**
   * The artifacts a turn adds: the reply text (under the id it was streamed with) and the
   * structured output, each with the event that delivers it.
   */
  private buildArtifacts(
    task: A2ATask,
    result: AgentRunResult,
    streamer?: ReplyStreamer | null
  ): { artifact: Artifact; event: TaskArtifactUpdateEvent }[] {
    const built: { artifact: Artifact; event: TaskArtifactUpdateEvent }[] = [];

    if (streamer?.started) {
      const event = streamer.finish(task, result.output);
      built.push({
        artifact: { artifactId: streamer.artifactId, parts: [textPart(result.output)] },
        event,
      });
    } else if (result.output) {
      built.push(this.wholeArtifact(task, [textPart(result.output)]));
    }

    const structured = this.structuredOutput(result);
    if (structured) {
      built.push(this.wholeArtifact(task, [{ kind: 'data', data: structured }]));
    }

    return built;
  }

  private wholeArtifact(
    task: A2ATask,
    parts: Part[]
  ): { artifact: Artifact; event: TaskArtifactUpdateEvent } {
    const artifact: Artifact = { artifactId: newArtifactId(), parts };
    return {
      artifact,
      event: {
        kind: 'artifact-update',
        taskId: task.id,
        contextId: task.contextId,
        artifact,
        lastChunk: true,
      },
    };
  }

  /**
   * A run that paused for tool approvals: the task waits in `input-required`, its status message
   * carries the calls in a tool approval request data part, and the client's decisions (a tool
   * approval response data part in the message that continues the task) resume the run.
   */
  private async requestApproval(
    taskId: string,
    result: AgentRunResult,
    streamer?: ReplyStreamer | null
  ): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));

    const pending = result.pendingApprovals ?? [];
    const calls = pending.map((approval) => approval.toolName).join(', ') || 'tool calls';
    const reply = agentMessage(existing, [
      ...(result.output ? [textPart(result.output)] : []),
      toolApprovalRequestPart(pending),
    ]);
    const status: TaskStatus = {
      state: 'input-required',
      message: agentMessage(existing, [
        textPart(`Waiting for approval of ${calls}`),
        toolApprovalRequestPart(pending),
      ]),
      timestamp: new Date().toISOString(),
    };

    return this.finishTurn(
      existing,
      status,
      reply,
      { ...result, output: streamer?.started ? result.output : '', structured: undefined },
      streamer,
      pending
    );
  }

  private async requestInput(
    taskId: string,
    result: AgentRunResult,
    streamer?: ReplyStreamer | null
  ): Promise<A2ATask> {
    const existing = await this.store.get(taskId);
    if (!existing) throw new A2AError(errors.taskNotFound(taskId));

    const question = agentMessage(existing, [textPart(result.output)]);
    const status: TaskStatus = {
      state: 'input-required',
      message: question,
      timestamp: new Date().toISOString(),
    };

    return this.finishTurn(existing, status, question, result, streamer);
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

  /**
   * Persist the outcome of an agent turn. Artifacts accumulate across turns,
   * and artifact events are emitted before the status event so streaming
   * consumers (which stop at the final status) never miss them.
   */
  private async finishTurn(
    existing: A2ATask,
    status: TaskStatus,
    reply: A2AMessage,
    result: AgentRunResult,
    streamer?: ReplyStreamer | null,
    pendingApprovals?: readonly ToolApprovalRequest[]
  ): Promise<A2ATask> {
    const built = this.buildArtifacts(existing, result, streamer);
    await this.store.update(existing.id, {
      status,
      artifacts: [...(existing.artifacts ?? []), ...built.map(({ artifact }) => artifact)],
      history: [...(existing.history ?? []), reply],
      ...this.withPendingApprovals(existing, pendingApprovals),
    });

    const updatedTask = await this.store.get(existing.id);
    if (!updatedTask) throw new A2AError(errors.taskNotFound(existing.id));

    for (const { event } of built) {
      this.emitEvent(event);
    }
    this.emitStatusUpdate(updatedTask);

    return updatedTask;
  }

  private async setStatus(taskId: string, status: TaskStatus): Promise<A2ATask> {
    await this.store.update(taskId, { status });
    const task = await this.store.get(taskId);
    if (!task) throw new A2AError(errors.taskNotFound(taskId));
    this.emitStatusUpdate(task);
    return task;
  }

  private emitStatusUpdate(task: A2ATask): void {
    this.emitEvent({
      kind: 'status-update',
      taskId: task.id,
      contextId: task.contextId,
      status: task.status,
      final: isStreamFinalState(task.status.state),
    });
  }

  private emitEvent(event: TaskEvent): void {
    this.emit('event', event);
  }
}
