import type {
  DurableRunHolder,
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

/** How a {@link DurableRunKeeper} keeps its run */
export interface DurableRunKeeperOptions {
  leaseMs: number;
  /** Tries again after a failed write, see `DurableRunsConfig.storeRetries` */
  retries: number;
  /** What happens when the store keeps failing, see `DurableRunsConfig.onStoreError` */
  onStoreError: 'suspend' | 'continue';
  /** The pause before the first retry, doubled for each one after it. Default: 100 ms */
  retryDelayMs?: number;
  /**
   * Stops the run: with `RUN_LEASED` when another process took it over, with `RUN_SUSPENDED` when
   * the store kept failing
   */
  stop: (error: CogitatorError) => void;
}

/** Default of `DurableRunsConfig.storeRetries` */
export const DEFAULT_STORE_RETRIES = 3;

const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * Keeps one durable run in its store while it goes on: holds its lease (renewed at every write
 * and a third of the way through it), writes its checkpoint after every step and the marks of
 * its tool calls and queue between them. Every write goes after the one before, so the journal
 * is in the order things happened, and a failed write is tried again with a growing pause. A
 * lease another process took over stops the run with `RUN_LEASED` before it starts a tool or
 * writes again. A store that keeps failing suspends the run (`RUN_SUSPENDED`) with its last
 * checkpoint kept, or with `onStoreError: 'continue'` lets it go on without checkpoints.
 */
export class DurableRunKeeper {
  private chain: Promise<unknown> = Promise.resolve();
  private renewal: ReturnType<typeof setInterval> | undefined;
  private base: readonly Message[] | undefined;
  /** Why the run may write no more: another process took it, or the store failed */
  private stopped: CogitatorError | undefined;
  /** The store failed and the run goes on without checkpoints (`onStoreError: 'continue'`) */
  private detached = false;
  private ended = false;

  constructor(
    private readonly store: DurableRunStore,
    readonly owner: DurableRunOwner,
    private readonly holder: DurableRunHolder,
    private readonly options: DurableRunKeeperOptions
  ) {}

  /** Takes the run, or fails with `RUN_LEASED` when another process holds it */
  async begin(): Promise<void> {
    const taken = await this.retried(() =>
      this.store.acquire(this.owner, this.holder, this.options.leaseMs)
    );
    if (!taken) throw leased(this.owner.runId);
    this.renewal = setInterval(
      () => {
        void this.queue(() => this.write(() => this.renew())).catch(() => undefined);
      },
      Math.max(1, Math.floor(this.options.leaseMs / 3))
    );
    this.renewal.unref?.();
  }

  /**
   * Writes the run's checkpoint: its messages without the base kept already and without those
   * its thread's log holds, its tool calls by their place in those messages, and an empty journal
   */
  save(checkpoint: RunCheckpoint, logged: LoggedMessages | undefined): Promise<void> {
    return this.queue(() =>
      this.write(async () => {
        await this.renew();
        const { messages, calls, base, baseFrom, whole, compact } = this.compact(
          checkpoint,
          logged
        );
        const record: DurableRunRecord = {
          ...this.owner,
          checkpoint: {
            ...checkpoint,
            status: 'running',
            messages,
            toolCalls: calls,
            compact,
          },
          ...(base && { base: [...base] }),
          ...(baseFrom !== undefined && { baseFrom }),
          journal: [],
          savedAt: Date.now(),
        };
        if (!(await this.store.save(record, this.holder))) this.lose();
        this.base = whole;
      })
    );
  }

  /** Notes that a tool call starts, once the run holds its lease: it may not start otherwise */
  started(toolCallId: string): Promise<void> {
    return this.queue(() =>
      this.write(async () => {
        await this.renew();
        await this.appendHeld([{ kind: 'started', toolCallId }]);
      })
    );
  }

  /** Notes what a tool call returned */
  finished(toolCallId: string, result: ToolResult): Promise<void> {
    const mark: DurableRunMark = { kind: 'finished', toolCallId, result: jsonSafeResult(result) };
    return this.queue(() => this.write(() => this.appendHeld([mark])));
  }

  /**
   * Notes that the run delivered `queued`, with the messages it added to the conversation, so a
   * recovery has them even before the next checkpoint and does not deliver it again
   */
  delivered(queued: QueuedRunMessage, messages: readonly Message[]): Promise<void> {
    const mark: DurableRunMark = {
      kind: 'delivered',
      queued: structuredClone(queued),
      messages: structuredClone([...messages]),
    };
    return this.queue(() => this.write(() => this.appendHeld([mark])));
  }

  /** Notes the messages queued on the run's handle that it has not delivered yet */
  queued(pending: readonly QueuedRunMessage[]): void {
    const mark: DurableRunMark = { kind: 'queue', pending: structuredClone([...pending]) };
    this.queue(() => this.write(() => this.appendHeld([mark]))).catch(() => undefined);
  }

  /**
   * Stops keeping the run. `forget` deletes it (it completed, paused, failed or was stopped)
   * unless another process took it over, `hand-over` keeps its checkpoint and lets its lease go,
   * for another process to recover it. A run whose store failed is never deleted: its last
   * checkpoint stays for a recovery
   */
  async end(how: 'forget' | 'hand-over'): Promise<void> {
    this.ended = true;
    clearInterval(this.renewal);
    await this.chain.catch(() => undefined);
    if (this.stopped?.code === ErrorCode.RUN_LEASED) return;
    const forget = how === 'forget' && !this.stopped;
    try {
      if (forget) {
        await this.retried(() => this.store.delete(this.owner, this.holder));
      } else {
        await this.store.release(this.owner, this.holder);
      }
    } catch (error) {
      getLogger().warn(
        forget
          ? 'Could not forget a durable run that ended: a recovery may find it'
          : 'Could not let a durable run go: another process takes it once its lease runs out',
        { runId: this.owner.runId, error: messageOf(error) }
      );
    }
  }

  private async renew(): Promise<void> {
    if (await this.store.renew(this.owner, this.holder, this.options.leaseMs)) return;
    this.lose();
  }

  private async appendHeld(marks: DurableRunMark[]): Promise<void> {
    if (!(await this.store.append(this.owner, marks, this.holder))) this.lose();
  }

  private lose(): never {
    const error = leased(this.owner.runId, true);
    this.halt(error);
    throw error;
  }

  private halt(error: CogitatorError): void {
    this.stopped ??= error;
    clearInterval(this.renewal);
    this.options.stop(error);
  }

  /**
   * Runs one write of the run: tried again after a failure, a run already stopped writes no more
   * (`RUN_LEASED`, `RUN_SUSPENDED`), one that went on without checkpoints skips it
   */
  private async write(write: () => Promise<void>): Promise<void> {
    if (this.stopped) throw this.stopped;
    if (this.detached || this.ended) return;
    try {
      await this.retried(write);
    } catch (error) {
      if (error instanceof CogitatorError && error.code === ErrorCode.RUN_LEASED) throw error;
      if (this.options.onStoreError === 'continue') {
        this.detached = true;
        clearInterval(this.renewal);
        getLogger().warn(
          'The durable run store keeps failing: the run goes on without checkpoints',
          {
            runId: this.owner.runId,
            error: messageOf(error),
          }
        );
        return;
      }
      const suspended = new CogitatorError({
        message: `The durable run store keeps failing (${messageOf(error)}): run ${this.owner.runId} is suspended with its last checkpoint kept`,
        code: ErrorCode.RUN_SUSPENDED,
        details: { runId: this.owner.runId },
        ...(error instanceof Error && { cause: error }),
      });
      this.halt(suspended);
      throw suspended;
    }
  }

  /** `operation`, tried again `retries` times with a growing pause while it throws */
  private async retried<T>(operation: () => Promise<T>): Promise<T> {
    const delay = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof CogitatorError && error.code === ErrorCode.RUN_LEASED) throw error;
        if (attempt >= this.options.retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay * 2 ** attempt));
      }
    }
  }

  private queue<T>(write: () => Promise<T>): Promise<T> {
    const next = this.chain.then(write);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private compact(
    checkpoint: RunCheckpoint,
    logged: LoggedMessages | undefined
  ): {
    messages: Message[];
    calls: ToolCall[];
    /** What to send of the base: all of it, the new part (from `baseFrom`), or none */
    base: readonly Message[] | undefined;
    baseFrom: number | undefined;
    /** The base the store holds once the save is done */
    whole: readonly Message[];
    compact: NonNullable<RunCheckpoint['compact']>;
  } {
    const all = checkpoint.messages;
    let lead = 0;
    while (lead < all.length && logged?.entryOf(all[lead]) === undefined) lead++;
    const kept = this.base;
    const grows =
      kept !== undefined &&
      kept.length <= lead &&
      kept.every((message, index) => all[index] === message);
    const base = all.slice(0, lead);
    const inline: Message[] = [];
    const entries: { at: number; entryId: string }[] = [];
    for (let at = base.length; at < all.length; at++) {
      const entryId = logged?.entryOf(all[at]);
      if (entryId !== undefined) entries.push({ at, entryId });
      else inline.push(all[at]);
    }
    const places = new Map<ToolCall, { at: number; index: number }>();
    all.forEach((message, at) => {
      callsOf(message).forEach((call, index) => {
        if (!places.has(call)) places.set(call, { at, index });
      });
    });
    const added = grows ? base.slice(kept.length) : base;
    return {
      messages: inline,
      calls: [],
      base: grows && added.length === 0 ? undefined : added,
      baseFrom: grows && added.length > 0 ? kept.length : undefined,
      whole: base,
      compact: {
        base: base.length,
        logged: entries,
        ...(logged?.tagged !== undefined && { written: logged.written, tag: logged.tagged }),
        calls: checkpoint.toolCalls.map((call) => places.get(call) ?? { call }),
      },
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  /**
   * The run gave its final answer before its process stopped, so it asks the model nothing more:
   * `stopping` when what happens at its stop (queued follow-ups, `Stop` hooks) had not settled
   * and runs again, `stopped` when it had and the run ends. Undefined when it had not answered
   */
  answered?: 'stopping' | 'stopped';
}

/**
 * The run `record` keeps, made whole: its messages read back from the base and the log, the
 * entries it wrote after its last checkpoint taken in (a model turn, tool results, delivered
 * messages, answers an earlier recovery saved), and the calls of its last turn settled from the
 * journal
 */
export async function rebuildDurableRun(
  record: DurableRunRecord,
  memory: MemoryAdapter | undefined
): Promise<RebuiltRun> {
  const { checkpoint } = record;
  const { messages, entryIds } = await wholeMessages(record, memory);
  const toolCalls = callsAt(record, messages);
  let iterations = checkpoint.iterations;
  let turnCalls = checkpoint.turn.toolCalls;
  let queued = [...(checkpoint.queued ?? [])];
  const queueKey = (item: QueuedRunMessage) => `${item.kind}:${JSON.stringify(item.content)}`;
  const delivered: Extract<DurableRunMark, { kind: 'delivered' }>[] = [];
  for (const mark of record.journal) {
    if (mark.kind === 'queue') queued = [...mark.pending];
    if (mark.kind === 'delivered') {
      const at = queued.findIndex((item) => queueKey(item) === queueKey(mark.queued));
      if (at !== -1) queued.splice(at, 1);
      delivered.push(mark);
    }
  }
  const adoptedQueued: string[] = [];

  const own = await runEntries(record, memory);
  const tag = checkpoint.compact?.tag;
  const written = checkpoint.compact?.written;
  const later =
    tag === undefined || written === undefined
      ? []
      : own.filter((entry) => entry.metadata?.[DURABLE_RUN_ENTRY_KEY] === tag).slice(written);
  for (const entry of later.filter(isConversation)) {
    const message = entry.message;
    messages.push(message);
    entryIds.push(entry.id);
    const calls = callsOf(message);
    if (message.role === 'assistant') {
      iterations++;
      turnCalls = calls;
      toolCalls.push(...calls);
    }
    const kind = entry.metadata?.queued;
    if (message.role === 'user' && (kind === 'steer' || kind === 'followUp' || kind === 'inject')) {
      const key = queueKey({ kind, content: message.content });
      adoptedQueued.push(key);
      const at = queued.findIndex((item) => queueKey(item) === key);
      if (at !== -1) queued.splice(at, 1);
    }
  }
  for (const mark of delivered) {
    const adopted = adoptedQueued.indexOf(queueKey(mark.queued));
    if (adopted !== -1) {
      adoptedQueued.splice(adopted, 1);
      continue;
    }
    messages.push(...mark.messages);
    entryIds.push(...mark.messages.map(() => undefined));
  }

  const answeredIds = new Set(
    messages.flatMap((message) =>
      message.role === 'tool' && message.toolCallId !== undefined ? [message.toolCallId] : []
    )
  );
  const turnAt = turnIndex(messages, turnCalls);
  const turnEntry = turnAt === undefined ? undefined : entryIds[turnAt];
  if (turnEntry !== undefined) {
    const seen = new Set(entryIds);
    const after = own.findIndex((entry) => entry.id === turnEntry);
    for (const entry of after === -1 ? [] : own.slice(after + 1)) {
      const id = entry.message.toolCallId;
      if (
        entry.message.role !== 'tool' ||
        id === undefined ||
        seen.has(entry.id) ||
        answeredIds.has(id) ||
        !turnCalls.some((call) => call.id === id)
      ) {
        continue;
      }
      messages.push(entry.message);
      entryIds.push(entry.id);
      answeredIds.add(id);
    }
  }

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
  const final = turnCalls.length === 0 && last?.role === 'assistant' && callsOf(last).length === 0;
  const answeredLater = later.some(
    (entry) => isConversation(entry) && entry.message.role === 'assistant'
  );
  const answered: RebuiltRun['answered'] = !final
    ? undefined
    : checkpoint.stopping || answeredLater
      ? 'stopping'
      : 'stopped';

  const { compact: _compact, queued: _queued, stopping: _stopping, ...rest } = checkpoint;
  const lastWritten = later.at(-1);
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
    ...(answered && { answered }),
  };
}

function failed(call: ToolCall, error: string): ToolResult {
  return { callId: call.id, name: call.name, result: null, error };
}

function callsOf(message: Message): ToolCall[] {
  const calls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls;
  return message.role === 'assistant' && Array.isArray(calls) ? calls : [];
}

/** The index of the assistant message that asked for `calls`, the last one that did */
function turnIndex(messages: readonly Message[], calls: readonly ToolCall[]): number | undefined {
  if (calls.length === 0) return undefined;
  const ids = calls.map((call) => call.id).join('\u0000');
  for (let at = messages.length - 1; at >= 0; at--) {
    const asked = callsOf(messages[at]);
    if (asked.length > 0 && asked.map((call) => call.id).join('\u0000') === ids) return at;
  }
  return undefined;
}

/** The run's tool calls, read from the messages they were kept by the place of */
function callsAt(record: DurableRunRecord, messages: readonly Message[]): ToolCall[] {
  const places = record.checkpoint.compact?.calls;
  if (!places) return [...record.checkpoint.toolCalls];
  return places.map((place) => {
    if ('call' in place) return place.call;
    const call = callsOf(messages[place.at] ?? { role: 'user', content: '' })[place.index];
    if (!call) throw unrecoverable(record, `a tool call of message ${place.at} is missing`);
    return call;
  });
}

/** The run's messages at its checkpoint, and the log entry of each that has one */
async function wholeMessages(
  record: DurableRunRecord,
  memory: MemoryAdapter | undefined
): Promise<{ messages: Message[]; entryIds: (string | undefined)[] }> {
  const { checkpoint } = record;
  const compact = checkpoint.compact;
  if (!compact) {
    return {
      messages: [...checkpoint.messages],
      entryIds: checkpoint.messages.map(() => undefined),
    };
  }
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
  const entryIds: (string | undefined)[] = messages.map(() => undefined);
  let inline = 0;
  for (let index = compact.base; index < total; index++) {
    const entryId = at.get(index);
    if (entryId === undefined) {
      messages.push(checkpoint.messages[inline++]);
      entryIds.push(undefined);
      continue;
    }
    const entry = entries.get(entryId);
    if (!entry) throw unrecoverable(record, `entry ${entryId} of its log is gone`);
    messages.push(entry.message);
    entryIds.push(entryId);
  }
  return { messages, entryIds };
}

/**
 * Every entry the run wrote to its thread's log, in any stretch of it (`metadata.durableRun`
 * starting with its id), in the order they were written
 */
async function runEntries(
  record: DurableRunRecord,
  memory: MemoryAdapter | undefined
): Promise<MemoryEntry[]> {
  if (!memory) return [];
  const found = await memory.getEntries({
    threadId: record.threadId,
    after: new Date(record.checkpoint.startedAt - CLOCK_MARGIN_MS),
    types: 'all',
    includeToolCalls: true,
  });
  if (!found.success) throw unrecoverable(record, found.error);
  const prefix = `${record.runId}/`;
  return found.data
    .filter((entry) => {
      const tag = entry.metadata?.[DURABLE_RUN_ENTRY_KEY];
      return typeof tag === 'string' && tag.startsWith(prefix);
    })
    .sort((a, b) =>
      a.seq !== undefined && b.seq !== undefined
        ? a.seq - b.seq
        : a.createdAt.getTime() - b.createdAt.getTime()
    );
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
