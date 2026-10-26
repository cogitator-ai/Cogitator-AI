import type {
  DurableRunMark,
  DurableRunRecord,
  DurableRunRef,
  DurableRunStore,
  MemoryAdapter,
  MemoryEntry,
  Message,
  QueuedRunMessage,
  RunCheckpoint,
  ToolCall,
  ToolResult,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { ABORTED_BEFORE_DISPATCH, OUTCOME_UNKNOWN } from '../utils/tool-history';

/** How long a durable run stays held after its process last renewed it, by default */
export const DEFAULT_DURABLE_LEASE_MS = 60_000;

/** The metadata key of the log entries a durable run writes, naming the run and the stretch of it */
export const DURABLE_RUN_ENTRY_KEY = 'durableRun';

/** How much earlier than a run's start its entries may be stamped, for clocks that disagree */
const CLOCK_MARGIN_MS = 5 * 60_000;

/** Entries fetched at once when a recovered run reads its messages back from the log */
const ENTRY_READS = 16;

/** Who a durable run belongs to, as its record names it */
export interface DurableRunOwner extends DurableRunRef {
  agentId: string;
  agentName: string;
  userId?: string;
}

/** Where a running durable run's messages are, see {@link DurableRunKeeper.save} */
export interface LoggedMessages {
  /** The log entry a message of the run was saved as, when it was */
  entryOf(message: Message): string | undefined;
  /** How many entries the run wrote to the log so far */
  readonly written: number;
  /** What its entries name in their metadata (`durableRun`) */
  readonly tagged: string | undefined;
}

/** A tool result as JSON can hold it, so every store keeps it as it was given */
export function jsonSafeResult(result: ToolResult): ToolResult {
  try {
    return JSON.parse(JSON.stringify(result)) as ToolResult;
  } catch {
    return {
      callId: result.callId,
      name: result.name,
      result: String(result.result),
      ...(result.error !== undefined && { error: result.error }),
    };
  }
}

/**
 * Keeps one durable run in its store while it goes on: holds its lease (renewed at every write
 * and a third of the way through it), writes its checkpoint after every step and the marks of
 * its tool calls and queue between them. Every write goes after the one before, so the journal
 * is in the order things happened. A lease another process took over stops the run through
 * `onLost`, before it starts a tool or writes again.
 */
export class DurableRunKeeper {
  private chain: Promise<unknown> = Promise.resolve();
  private renewal: ReturnType<typeof setInterval> | undefined;
  private base: readonly Message[] | undefined;
  private lost: CogitatorError | undefined;
  private ended = false;

  constructor(
    private readonly store: DurableRunStore,
    readonly owner: DurableRunOwner,
    private readonly holder: string,
    private readonly leaseMs: number,
    private readonly onLost: (error: CogitatorError) => void
  ) {}

  /** Takes the run, or fails with `RUN_LEASED` when another process holds it */
  async begin(): Promise<void> {
    if (!(await this.store.acquire(this.owner, this.holder, this.leaseMs))) {
      throw leased(this.owner.runId);
    }
    this.renewal = setInterval(
      () => {
        void this.renew().catch((error: unknown) => {
          getLogger().warn('Could not renew the lease of a durable run', {
            runId: this.owner.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      Math.max(1, Math.floor(this.leaseMs / 3))
    );
    this.renewal.unref?.();
  }

  /**
   * Writes the run's checkpoint: its messages without the base kept already and without those
   * its thread's log holds, and an empty journal
   */
  save(checkpoint: RunCheckpoint, logged: LoggedMessages | undefined): Promise<void> {
    return this.queue(async () => {
      await this.renew();
      const { messages, base, compact } = this.compactMessages(checkpoint.messages, logged);
      const record: DurableRunRecord = {
        ...this.owner,
        checkpoint: { ...checkpoint, status: 'running', messages, compact },
        ...(base && { base: [...base] }),
        journal: [],
        savedAt: Date.now(),
      };
      await this.store.save(record);
    });
  }

  /** Notes that a tool call starts, once the run holds its lease: it may not start otherwise */
  started(toolCallId: string): Promise<void> {
    return this.queue(async () => {
      await this.renew();
      await this.store.append(this.owner, [{ kind: 'started', toolCallId }]);
    });
  }

  /** Notes what a tool call returned */
  finished(toolCallId: string, result: ToolResult): Promise<void> {
    return this.queue(() =>
      this.store.append(this.owner, [
        { kind: 'finished', toolCallId, result: jsonSafeResult(result) },
      ])
    );
  }

  /** Notes the messages queued on the run's handle that it has not delivered yet */
  queued(pending: readonly QueuedRunMessage[]): void {
    const mark: DurableRunMark = { kind: 'queue', pending: structuredClone([...pending]) };
    this.queue(() => this.store.append(this.owner, [mark])).catch((error: unknown) => {
      getLogger().warn('Could not note the queue of a durable run', {
        runId: this.owner.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Stops keeping the run: `forget` deletes it (it completed, paused, failed or was stopped)
   * unless another process took it over, `hand-over` keeps its checkpoint and lets its lease go,
   * for another process to recover it
   */
  async end(how: 'forget' | 'hand-over'): Promise<void> {
    this.ended = true;
    clearInterval(this.renewal);
    await this.chain.catch(() => undefined);
    if (this.lost) return;
    if (how === 'hand-over') {
      await this.store.release(this.owner, this.holder);
      return;
    }
    if (await this.store.renew(this.owner, this.holder, this.leaseMs)) {
      await this.store.delete(this.owner);
    }
  }

  private async renew(): Promise<void> {
    if (this.lost) throw this.lost;
    if (this.ended) return;
    if (await this.store.renew(this.owner, this.holder, this.leaseMs)) return;
    this.lost = leased(this.owner.runId, true);
    clearInterval(this.renewal);
    this.onLost(this.lost);
    throw this.lost;
  }

  private queue<T>(write: () => Promise<T>): Promise<T> {
    const next = this.chain.then(write);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private compactMessages(
    messages: readonly Message[],
    logged: LoggedMessages | undefined
  ): {
    messages: Message[];
    base: readonly Message[] | undefined;
    compact: NonNullable<RunCheckpoint['compact']>;
  } {
    let lead = 0;
    while (lead < messages.length && logged?.entryOf(messages[lead]) === undefined) lead++;
    const kept = this.base;
    const reuses =
      kept !== undefined &&
      kept.length <= lead &&
      kept.every((message, index) => messages[index] === message);
    const base = reuses ? kept : messages.slice(0, lead);
    this.base = base;
    const inline: Message[] = [];
    const entries: { at: number; entryId: string }[] = [];
    for (let at = base.length; at < messages.length; at++) {
      const entryId = logged?.entryOf(messages[at]);
      if (entryId !== undefined) entries.push({ at, entryId });
      else inline.push(messages[at]);
    }
    return {
      messages: inline,
      base: reuses ? undefined : base,
      compact: {
        base: base.length,
        logged: entries,
        ...(logged?.tagged !== undefined && { written: logged.written, tag: logged.tagged }),
      },
    };
  }
}

function leased(runId: string, takenOver = false): CogitatorError {
  return new CogitatorError({
    message: takenOver
      ? `Another process took over durable run ${runId}`
      : `Durable run ${runId} is held by another process`,
    code: ErrorCode.RUN_LEASED,
    details: { runId },
  });
}

/** A durable run made whole again from its store and its thread's log, ready to go on */
export interface RebuiltRun {
  /** The checkpoint to resume, its messages whole and its turn's settled calls `completed` */
  checkpoint: RunCheckpoint;
  /**
   * Answers for calls of the turn that never got one in the log: what a call returned before the
   * process stopped, "outcome unknown" for one that started and never returned, "aborted before
   * dispatch" for one that never started after such a call. The run saves them first
   */
  repairs: { toolCall: ToolCall; result: ToolResult }[];
  /** Messages queued on the run's handle it had not delivered */
  queued: QueuedRunMessage[];
  /** The run gave its final answer before it stopped: it ends without another model call */
  answered: boolean;
}

/**
 * The run `record` keeps, made whole: its messages read back from the base and the log, the
 * entries it wrote after its last checkpoint taken in (a model turn, tool results, delivered
 * messages), and the calls of its last turn settled from the journal
 */
export async function rebuildDurableRun(
  record: DurableRunRecord,
  memory: MemoryAdapter | undefined
): Promise<RebuiltRun> {
  const { checkpoint } = record;
  const messages = await wholeMessages(record, memory);
  const toolCalls = [...checkpoint.toolCalls];
  let iterations = checkpoint.iterations;
  let turnCalls = checkpoint.turn.toolCalls;
  let queued = [...(checkpoint.queued ?? [])];
  for (const mark of record.journal) if (mark.kind === 'queue') queued = [...mark.pending];

  const written = await laterEntries(record, memory);
  const later = written.filter(isConversation);
  for (const entry of later) {
    const message = entry.message;
    messages.push(message);
    const calls = callsOf(message);
    if (message.role === 'assistant') {
      iterations++;
      turnCalls = calls;
      toolCalls.push(...calls);
    }
    const kind = entry.metadata?.queued;
    if (message.role === 'user' && typeof kind === 'string') {
      const at = queued.findIndex(
        (item) =>
          item.kind === kind && JSON.stringify(item.content) === JSON.stringify(message.content)
      );
      if (at !== -1) queued.splice(at, 1);
    }
  }

  const answeredIds = new Set(
    messages.flatMap((message) =>
      message.role === 'tool' && message.toolCallId !== undefined ? [message.toolCallId] : []
    )
  );
  const finished = new Map<string, ToolResult>();
  const started = new Set<string>();
  for (const mark of record.journal) {
    if (mark.kind === 'started') started.add(mark.toolCallId);
    if (mark.kind === 'finished') finished.set(mark.toolCallId, mark.result);
  }
  const open = turnCalls.filter((call) => !answeredIds.has(call.id));
  const unknown = open.some((call) => started.has(call.id) && !finished.has(call.id));
  const repairs: RebuiltRun['repairs'] = [];
  for (const call of open) {
    const returned = finished.get(call.id);
    if (returned) {
      repairs.push({ toolCall: call, result: { ...returned, callId: call.id, name: call.name } });
    } else if (started.has(call.id)) {
      repairs.push({ toolCall: call, result: failed(call, OUTCOME_UNKNOWN) });
    } else if (unknown) {
      repairs.push({ toolCall: call, result: failed(call, ABORTED_BEFORE_DISPATCH) });
    }
  }
  const settled = turnCalls
    .filter(
      (call) => answeredIds.has(call.id) || repairs.some((repair) => repair.toolCall === call)
    )
    .map((call) => call.id);
  const last = messages.at(-1);
  const answered =
    turnCalls.length === 0 &&
    last?.role === 'assistant' &&
    callsOf(last).length === 0 &&
    later.some((entry) => entry.message.role === 'assistant');

  const { compact: _compact, queued: _queued, ...rest } = checkpoint;
  const lastWritten = written.at(-1);
  const branch =
    checkpoint.branch?.parentId !== undefined && lastWritten
      ? { ...checkpoint.branch, parentId: lastWritten.id }
      : checkpoint.branch;
  return {
    checkpoint: {
      ...rest,
      ...(branch && { branch }),
      status: 'running',
      messages,
      toolCalls,
      iterations,
      turn:
        turnCalls === checkpoint.turn.toolCalls
          ? { ...checkpoint.turn, completed: settled }
          : { toolCalls: turnCalls, decisions: {}, completed: settled },
    },
    repairs,
    queued,
    answered,
  };
}

function failed(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, name: call.name, result: null, error };
}

function callsOf(message: Message): ToolCall[] {
  const calls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls;
  return message.role === 'assistant' && Array.isArray(calls) ? calls : [];
}

/** The run's messages at its checkpoint: the base, the inline ones and those of the log */
async function wholeMessages(
  record: DurableRunRecord,
  memory: MemoryAdapter | undefined
): Promise<Message[]> {
  const { checkpoint } = record;
  const compact = checkpoint.compact;
  if (!compact) return [...checkpoint.messages];
  const base = record.base ?? [];
  if (base.length < compact.base) {
    throw unrecoverable(record, `its first ${compact.base} messages are missing from its store`);
  }
  const ids = compact.logged.map((ref) => ref.entryId);
  const entries = new Map<string, MemoryEntry>();
  if (ids.length > 0) {
    if (!memory) throw unrecoverable(record, 'its messages are in a memory log this runtime lacks');
    for (let from = 0; from < ids.length; from += ENTRY_READS) {
      const read = await Promise.all(
        ids.slice(from, from + ENTRY_READS).map((id) => memory.getEntry(id))
      );
      for (const found of read) {
        if (!found.success) throw unrecoverable(record, found.error);
        if (found.data) entries.set(found.data.id, found.data);
      }
    }
  }
  const total = compact.base + compact.logged.length + checkpoint.messages.length;
  const at = new Map(compact.logged.map((ref) => [ref.at, ref.entryId]));
  const messages: Message[] = base.slice(0, compact.base);
  let inline = 0;
  for (let index = compact.base; index < total; index++) {
    const entryId = at.get(index);
    if (entryId === undefined) {
      messages.push(checkpoint.messages[inline++]);
      continue;
    }
    const entry = entries.get(entryId);
    if (!entry) throw unrecoverable(record, `entry ${entryId} of its log is gone`);
    messages.push(entry.message);
  }
  return messages;
}

/**
 * The entries the run wrote to its log after its checkpoint, in order: the entries of its
 * stretch (`metadata.durableRun`) past the ones the checkpoint counted
 */
async function laterEntries(
  record: DurableRunRecord,
  memory: MemoryAdapter | undefined
): Promise<MemoryEntry[]> {
  const written = record.checkpoint.compact?.written;
  const tag = record.checkpoint.compact?.tag;
  if (!memory || written === undefined || tag === undefined) return [];
  const found = await memory.getEntries({
    threadId: record.threadId,
    after: new Date(record.checkpoint.startedAt - CLOCK_MARGIN_MS),
    types: 'all',
    includeToolCalls: true,
  });
  if (!found.success) throw unrecoverable(record, found.error);
  const own = found.data
    .filter((entry) => entry.metadata?.[DURABLE_RUN_ENTRY_KEY] === tag)
    .sort((a, b) =>
      a.seq !== undefined && b.seq !== undefined
        ? a.seq - b.seq
        : a.createdAt.getTime() - b.createdAt.getTime()
    );
  return own.slice(written);
}

/** Whether `entry` is part of the conversation the model reads, not an event or a cut reply */
function isConversation(entry: MemoryEntry): boolean {
  return (
    (entry.type === undefined || entry.type === 'message' || entry.type === 'tool_result') &&
    entry.metadata?.interrupted !== true
  );
}

function unrecoverable(record: DurableRunRecord, why: string): CogitatorError {
  return new CogitatorError({
    message: `Durable run ${record.runId} cannot be recovered: ${why}`,
    code: ErrorCode.VALIDATION_ERROR,
    details: { runId: record.runId },
  });
}
