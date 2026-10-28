/**
 * The client side of MCP tasks (extension io.modelcontextprotocol/tasks, protocol 2026-07-28):
 * a tool call the server answers with a task is polled with `tasks/get` until it ends, its input
 * requests answered with `tasks/update`, and cancelled with `tasks/cancel` when the call is
 */

import { z } from 'zod';
import type { MCPClientTaskRecord, MCPClientTaskStore } from '../types';
import { answerElicitation, toElicitRequest, type InputAnswerer } from './input';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const MIN_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;

export const TaskSchema = z.looseObject({
  taskId: z.string().min(1),
  status: z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']),
  statusMessage: z.string().optional(),
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  ttlMs: z.number().nullable(),
  pollIntervalMs: z.number().optional(),
  inputRequests: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .looseObject({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});

export type ClientTask = z.output<typeof TaskSchema>;

/** How a task ended when it did not complete */
export class MCPTaskEndedError extends Error {
  readonly status: 'failed' | 'cancelled';
  readonly taskId: string;
  readonly code?: number;

  constructor(task: ClientTask, toolName: string) {
    const status = task.status === 'failed' ? 'failed' : 'cancelled';
    const why = task.error?.message ?? task.statusMessage;
    super(
      `The task ${task.taskId} of MCP tool "${toolName}" ${status === 'failed' ? 'failed' : 'was cancelled'}` +
        (why ? `: ${why}` : '')
    );
    this.name = 'MCPTaskEndedError';
    this.status = status;
    this.taskId = task.taskId;
    if (task.error) this.code = task.error.code;
  }
}

/** Tasks kept in the client's memory, the default {@link MCPClientTaskStore} */
export class InMemoryMCPClientTaskStore implements MCPClientTaskStore {
  private readonly records = new Map<string, MCPClientTaskRecord>();

  get(key: string): Promise<MCPClientTaskRecord | undefined> {
    const record = this.records.get(key);
    return Promise.resolve(record && { ...record, asked: [...record.asked] });
  }

  set(key: string, record: MCPClientTaskRecord): Promise<void> {
    this.records.set(key, { ...record, asked: [...record.asked] });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.records.delete(key);
    return Promise.resolve();
  }
}

/** What polling a task needs from the client that started it */
export interface TaskHost {
  request(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>>;
  /** Restores a lost connection, so polling the same task goes on */
  restore(error: unknown): Promise<boolean>;
}

export interface SettleTaskOptions {
  host: TaskHost;
  toolName: string;
  answerer: InputAnswerer;
  store: MCPClientTaskStore;
  /** The store key of the call, its tool call id, when it has one */
  storeKey?: string;
  maxPollIntervalMs: number;
  signal?: AbortSignal;
  update?: (statusMessage: string) => void;
}

/**
 * Waits for `task` to end and returns the tool result it completed with. The task is kept in the
 * store under the call's key until then, so the call can come back to it
 */
export async function settleTask(
  task: ClientTask,
  options: SettleTaskOptions
): Promise<Record<string, unknown>> {
  const { host, store, storeKey, answerer, signal } = options;
  const record: MCPClientTaskRecord = {
    taskId: task.taskId,
    tool: options.toolName,
    createdAt: new Date().toISOString(),
    asked: answerer.ledger,
  };
  if (storeKey) await store.set(storeKey, record);

  let current = task;
  let lastMessage: string | undefined;
  try {
    for (;;) {
      if (current.statusMessage && current.statusMessage !== lastMessage) {
        lastMessage = current.statusMessage;
        options.update?.(current.statusMessage);
      }
      switch (current.status) {
        case 'completed':
          if (storeKey) await store.delete(storeKey);
          return current.result ?? { content: [] };
        case 'failed':
        case 'cancelled':
          if (storeKey) await store.delete(storeKey);
          throw new MCPTaskEndedError(current, options.toolName);
        case 'input_required': {
          const responses = await answerTaskInput(current, answerer, async () => {
            if (storeKey) await store.set(storeKey, { ...record, asked: [...answerer.ledger] });
          });
          if (Object.keys(responses).length > 0) {
            await withRestore(host, () =>
              host.request(
                'tasks/update',
                { taskId: current.taskId, inputResponses: responses },
                signal
              )
            );
          }
          break;
        }
        case 'working':
          break;
      }
      await delay(pollInterval(current, options.maxPollIntervalMs), signal);
      current = TaskSchema.parse(
        await withRestore(host, () => host.request('tasks/get', { taskId: current.taskId }, signal))
      );
    }
  } catch (error) {
    if (signal?.aborted) {
      await host.request('tasks/cancel', { taskId: current.taskId }).catch(() => undefined);
      if (storeKey) await store.delete(storeKey);
    }
    throw error;
  }
}

/**
 * The answers to the outstanding input requests of `task`. The questions the call asked through
 * its run come first, in the order it asked them, so a run that resumed reads its answers in
 * order: those the task no longer waits on are only read
 */
async function answerTaskInput(
  task: ClientTask,
  answerer: InputAnswerer,
  persist: () => Promise<void>
): Promise<Record<string, unknown>> {
  const consumed = answerer.consumed;
  const outstanding = task.inputRequests ?? {};
  for (const [key, value] of Object.entries(outstanding)) {
    if (consumed.has(key) || answerer.ledger.some((entry) => entry.key === key)) continue;
    const params = z.looseObject({ method: z.string(), params: z.unknown() }).safeParse(value);
    if (!params.success || params.data.method !== 'elicitation/create') {
      consumed.add(key);
      continue;
    }
    answerer.ledger.push({ key, request: toElicitRequest(params.data.params) });
  }
  await persist();
  const responses: Record<string, unknown> = {};
  for (const entry of [...answerer.ledger]) {
    if (consumed.has(entry.key)) continue;
    if (!answerer.interrupt && !(entry.key in outstanding)) continue;
    const answer = await answerElicitation(entry.request, answerer);
    consumed.add(entry.key);
    if (entry.key in outstanding) responses[entry.key] = answer;
  }
  return responses;
}

async function withRestore<T>(host: TaskHost, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (await host.restore(error)) return operation();
    throw error;
  }
}

function pollInterval(task: ClientTask, max: number): number {
  const suggested = task.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  return Math.min(Math.max(suggested, MIN_POLL_INTERVAL_MS), max);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}
