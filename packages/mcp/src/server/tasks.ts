/**
 * The server side of MCP tasks (extension io.modelcontextprotocol/tasks, protocol 2026-07-28):
 * a tool call that runs long becomes a task the client polls with `tasks/get`, answers the
 * questions of with `tasks/update` and stops with `tasks/cancel`
 */

import { randomBytes } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type {
  MCPElicitRequest,
  MCPElicitResult,
  MCPServerTaskOptions,
  MCPTaskInputRequest,
  MCPTaskRecord,
  MCPTaskStore,
} from '../types';
import type { CallExecution } from './execution';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_PROMOTE_AFTER_MS = 2000;

/** Tasks kept in the server's memory, the default {@link MCPTaskStore}, each until its TTL ends */
export class InMemoryMCPTaskStore implements MCPTaskStore {
  private readonly records = new Map<string, MCPTaskRecord>();

  create(record: MCPTaskRecord): Promise<void> {
    this.sweep();
    this.records.set(record.taskId, { ...record });
    return Promise.resolve();
  }

  get(taskId: string): Promise<MCPTaskRecord | undefined> {
    this.sweep();
    const record = this.records.get(taskId);
    return Promise.resolve(record && { ...record });
  }

  update(
    taskId: string,
    patch: Partial<Omit<MCPTaskRecord, 'taskId' | 'owner'>>
  ): Promise<MCPTaskRecord | undefined> {
    const record = this.records.get(taskId);
    if (!record) return Promise.resolve(undefined);
    const next: MCPTaskRecord = { ...record, ...patch };
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[key] === undefined) delete next[key];
    }
    this.records.set(taskId, next);
    return Promise.resolve({ ...next });
  }

  delete(taskId: string): Promise<void> {
    this.records.delete(taskId);
    return Promise.resolve();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [taskId, record] of this.records) {
      if (record.ttlMs !== null && Date.parse(record.createdAt) + record.ttlMs < now) {
        this.records.delete(taskId);
      }
    }
  }
}

/** How a task's call goes on after the client answered what it asked */
export interface TaskResume {
  /** The answers to the questions the call ended its round with, and the state it kept */
  input?: { responses: Record<string, MCPElicitResult>; state: unknown };
}

/** Starts a run of the task's call again, after it ended asking */
export type TaskRestart = (resume: TaskResume) => CallExecution;

/** The task as `tasks/get` and `notifications/tasks` carry it */
export type TaskWire = Omit<MCPTaskRecord, 'owner' | 'inputRequests'> & {
  inputRequests?: Record<string, MCPTaskInputRequest>;
};

interface Runner {
  execution: CallExecution;
  waiting: Map<string, (answer: MCPElicitResult) => void>;
  cancelled: boolean;
}

/** The tasks of one MCP server: their records in the store, their runs in this process */
export class ServerTasks {
  readonly store: MCPTaskStore;
  private readonly ttlMs: number;
  private readonly pollIntervalMs: number;
  private readonly runners = new Map<string, Runner>();

  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    options: MCPServerTaskOptions,
    private readonly log: (message: string) => void,
    /** How long a question of a task waits for its answer, in ms */
    private readonly questionTimeoutMs: () => number
  ) {
    this.store = options.store ?? new InMemoryMCPTaskStore();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Makes `execution` a task of `owner` and runs it on: the task is in the store before this
   * resolves with it, as the protocol requires
   */
  async start(owner: string, execution: CallExecution, restart: TaskRestart): Promise<TaskWire> {
    const now = new Date().toISOString();
    const record: MCPTaskRecord = {
      taskId: randomBytes(16).toString('base64url'),
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: this.ttlMs,
      pollIntervalMs: this.pollIntervalMs,
      owner,
    };
    await this.store.create(record);
    const runner: Runner = { execution, waiting: new Map(), cancelled: false };
    this.runners.set(record.taskId, runner);
    const expiry = setTimeout(() => void this.expire(record.taskId), this.ttlMs);
    expiry.unref?.();
    this.expiries.set(record.taskId, expiry);
    void this.run(record.taskId, runner, restart);
    return toWire(record);
  }

  /** The task for `tasks/get`, refused as unknown when it is not `owner`'s */
  async get(taskId: string, owner: string): Promise<TaskWire> {
    return toWire(await this.owned(taskId, owner));
  }

  /** Delivers answers of `tasks/update`; answers to keys the task does not wait on are ignored */
  async update(
    taskId: string,
    owner: string,
    inputResponses: Record<string, unknown>
  ): Promise<void> {
    await this.owned(taskId, owner);
    const runner = this.runners.get(taskId);
    if (!runner) return;
    for (const [key, answer] of Object.entries(inputResponses)) {
      const deliver = runner.waiting.get(key);
      const parsed = parseElicitResult(answer);
      if (!deliver || !parsed) continue;
      runner.waiting.delete(key);
      deliver(parsed);
    }
  }

  /** Stops the task's run (`tasks/cancel`), which ends `cancelled` unless it finished already */
  async cancel(taskId: string, owner: string): Promise<void> {
    const record = await this.owned(taskId, owner);
    if (
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'cancelled'
    ) {
      return;
    }
    const runner = this.runners.get(taskId);
    if (runner) {
      this.stop(runner, new Error('The task was cancelled'));
      this.runners.delete(taskId);
    }
    await this.patch(taskId, { status: 'cancelled', statusMessage: 'Cancelled by the client' });
  }

  /** Stops every run, for a server that stops */
  closeAll(): void {
    for (const runner of this.runners.values()) this.stop(runner, new Error('The server stopped'));
    this.runners.clear();
    for (const expiry of this.expiries.values()) clearTimeout(expiry);
    this.expiries.clear();
  }

  /** Ends a task whose TTL ran out: its run stops and its record goes */
  private async expire(taskId: string): Promise<void> {
    this.expiries.delete(taskId);
    const runner = this.runners.get(taskId);
    if (runner) {
      this.runners.delete(taskId);
      this.stop(runner, new Error('The task expired'));
    }
    await this.store.delete(taskId).catch(() => undefined);
  }

  private stop(runner: Runner, reason: Error): void {
    runner.cancelled = true;
    runner.execution.cancel(reason);
    for (const deliver of runner.waiting.values()) deliver({ action: 'cancel' });
    runner.waiting.clear();
  }

  private async run(taskId: string, runner: Runner, restart: TaskRestart): Promise<void> {
    let generation = 0;
    try {
      for (;;) {
        const step = await runner.execution.next();
        if (runner.cancelled) return;
        if (step.kind === 'done') {
          if (step.pendingApproval) {
            runner.execution = restart({});
            generation++;
            continue;
          }
          await this.patch(taskId, {
            status: 'completed',
            result: { ...step.result },
            inputRequests: undefined,
            statusMessage: undefined,
          });
          return;
        }
        if (step.kind === 'ask') {
          const key = `${generation}:${step.key}`;
          const [answer] = await this.waitFor(taskId, runner, { [key]: step.request });
          if (runner.cancelled || answer === undefined) return;
          runner.execution.respond(step.key, answer.answer);
          await this.patch(taskId, {
            status: 'working',
            inputRequests: undefined,
            statusMessage: undefined,
          });
          continue;
        }
        const prefix = `${generation}:`;
        const requests = Object.fromEntries(
          Object.entries(step.requests).map(([key, request]) => [`${prefix}${key}`, request])
        );
        const answers = await this.waitFor(taskId, runner, requests);
        if (runner.cancelled) return;
        const responses = Object.fromEntries(
          answers.map(({ key, answer }) => [key.slice(prefix.length), answer])
        );
        generation++;
        runner.execution = restart({ input: { responses, state: step.state } });
        await this.patch(taskId, {
          status: 'working',
          inputRequests: undefined,
          statusMessage: undefined,
        });
      }
    } catch (error) {
      if (runner.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Task ${taskId} failed: ${message}`);
      await this.patch(taskId, {
        status: 'failed',
        statusMessage: message,
        error: { code: ProtocolErrorCode.InternalError, message },
        inputRequests: undefined,
      }).catch(() => undefined);
    } finally {
      if (this.runners.get(taskId) === runner) this.runners.delete(taskId);
    }
  }

  /**
   * Sets the task `input_required` with `requests` and waits for every answer. A question
   * nobody answers within the question timeout counts as dismissed (`cancel`)
   */
  private async waitFor(
    taskId: string,
    runner: Runner,
    requests: Record<string, MCPElicitRequest>
  ): Promise<{ key: string; answer: MCPElicitResult }[]> {
    const answers = Object.keys(requests).map(
      (key) =>
        new Promise<{ key: string; answer: MCPElicitResult }>((resolve) => {
          runner.waiting.set(key, (answer) => resolve({ key, answer }));
        })
    );
    const timer = setTimeout(() => {
      this.log(`Nobody answered the questions of task ${taskId} in time`);
      for (const deliver of runner.waiting.values()) deliver({ action: 'cancel' });
      runner.waiting.clear();
    }, this.questionTimeoutMs());
    timer.unref?.();
    void Promise.all(answers).finally(() => clearTimeout(timer));
    await this.patch(taskId, {
      status: 'input_required',
      statusMessage: 'Waiting for the user to answer',
      inputRequests: Object.fromEntries(
        Object.entries(requests).map(([key, request]) => [key, toInputRequest(request)])
      ),
    });
    return Promise.all(answers);
  }

  private async patch(
    taskId: string,
    patch: Partial<Omit<MCPTaskRecord, 'taskId' | 'owner'>>
  ): Promise<void> {
    await this.store.update(taskId, { ...patch, lastUpdatedAt: new Date().toISOString() });
  }

  private async owned(taskId: string, owner: string): Promise<MCPTaskRecord> {
    const record = await this.store.get(taskId);
    if (record?.owner !== owner) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    }
    return record;
  }
}

/** An elicitation form as an input request of a task */
export function toInputRequest(request: MCPElicitRequest): MCPTaskInputRequest {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message: request.message, requestedSchema: request.schema },
  };
}

function toWire(record: MCPTaskRecord): TaskWire {
  const { owner: _owner, ...task } = record;
  return task;
}

/** An answer to an elicitation as a client sends it, undefined for anything else */
export function parseElicitResult(value: unknown): MCPElicitResult | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const action = (value as { action?: unknown }).action;
  if (action === 'decline' || action === 'cancel') return { action };
  if (action !== 'accept') return undefined;
  const content = (value as { content?: unknown }).content;
  return {
    action: 'accept',
    content:
      typeof content === 'object' && content !== null && !Array.isArray(content)
        ? (content as Record<string, unknown>)
        : {},
  };
}
