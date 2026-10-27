import { nanoid } from 'nanoid';
import {
  FILE_CHECKPOINT_KEY,
  type FileCheckpointRef,
  type MemoryAdapter,
  type MemoryEntry,
  type Message,
  type RunCheckpoint,
  type RunMemoryPlace,
  type RunOptions,
  type ToolCall,
  type ToolResult,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { saveEntry, type EntryEvent, type EntryPlacement } from './message-builder';

/** A file checkpoint taken for a user message, and how to drop it when the message is not written */
export interface TakenCheckpoint {
  ref: FileCheckpointRef;
  discard(): Promise<void>;
}

/**
 * What a run writes to its thread's memory, in the order it writes it. A run on a branch
 * (`RunOptions.branch`) chains its entries after the branch point, any other run adds each one
 * after the thread's active leaf, so runs that share a thread at once all stay on its active
 * branch. Writes and session events go one after another, so an event recorded from a callback
 * still lands before the entries that follow it, and a failed write does not stop the ones after
 * it. Nothing is written before {@link open}, which the runtime calls once the run may use the
 * thread.
 */
export class RunMemory {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly place: EntryPlacement;
  private opened = false;
  private branchPoint: string | null | undefined;
  private leafId: string | undefined;
  /** The entry each message the run saved became */
  private readonly entries = new WeakMap<Message, string>();
  /** Entries the run wrote */
  private count = 0;
  /** Set once the run may write no more, see {@link seal} */
  private sealed = false;
  /** The lease epoch the run's entries name, see {@link epoch} */
  private leaseEpoch: number | undefined;
  /** Checked before every write, see {@link guard} */
  private check: (() => Promise<void>) | undefined;
  /** What the run's entries name in their metadata, for a durable run */
  private taggedRun: string | undefined;
  /** Takes the file checkpoint of a user message about to be written, see {@link checkpoints} */
  private checkpointer: ((entryId: string) => Promise<TakenCheckpoint | undefined>) | undefined;

  /**
   * @param memory the runtime's memory adapter when it writes, read then: memory connects
   *   after a run starts
   * @param options the run's options when it writes: a resumed run takes the user of its
   *   checkpoint
   */
  constructor(
    private readonly memory: () => MemoryAdapter | undefined,
    private readonly threadId: string,
    private readonly options: () => RunOptions
  ) {
    const branch = options().branch;
    this.place = branch ? { parentId: branch.fromEntryId, activate: branch.activate ?? true } : {};
  }

  /**
   * Lets the run write to its thread, once its access to it is checked. A paused run passes the
   * place its checkpoint kept, to go on along its branch.
   */
  open(resumed?: RunCheckpoint['branch']): void {
    if (resumed) {
      if (resumed.parentId !== undefined) this.place.parentId = resumed.parentId;
      this.place.activate = resumed.activate;
      if (resumed.branchPoint !== undefined) this.branchPoint = resumed.branchPoint;
    }
    this.opened = true;
  }

  /** Whether the run leaves the thread's active leaf where it is (`activate: false`) */
  get aside(): boolean {
    return this.place.activate === false;
  }

  /**
   * Where the run reads its conversation, once it may use memory, also when it saves none
   * (`saveHistory: false`): its thread and newest entry, and once it saved an entry, the entry its
   * own entries follow (`ownAfter`, null at the root of the thread)
   */
  get conversation():
    { threadId: string; leafId?: string | null; ownAfter?: string | null } | undefined {
    if (!this.opened || !this.memory() || this.options().useMemory === false) return undefined;
    const leafId = this.leafId ?? this.place.parentId;
    return {
      threadId: this.threadId,
      ...(leafId !== undefined && { leafId }),
      ...(this.branchPoint !== undefined && { ownAfter: this.branchPoint }),
    };
  }

  /** Whether the run may write to its thread: {@link open} was called */
  get isOpen(): boolean {
    return this.opened;
  }

  /** Whether the run saves to memory */
  get enabled(): boolean {
    const options = this.options();
    return (
      this.memory() !== undefined && options.saveHistory !== false && options.useMemory !== false
    );
  }

  /** Where the run's next entry goes and where it started, for a paused run to go on */
  get placement(): RunCheckpoint['branch'] {
    if (this.place.parentId === undefined && this.branchPoint === undefined) return undefined;
    return {
      ...(this.place.parentId !== undefined && { parentId: this.place.parentId }),
      activate: this.place.activate ?? true,
      ...(this.branchPoint !== undefined && { branchPoint: this.branchPoint }),
    };
  }

  /**
   * Names `tag` in the metadata (`durableRun`) of every entry the run writes from now on, so a
   * durable run that stopped finds the entries it wrote after its last checkpoint
   */
  tag(tag: string): void {
    this.taggedRun = tag;
  }

  /**
   * Names the epoch of the durable run's lease in the metadata (`durableEpoch`) of every entry it
   * writes from now on, so readers drop what it wrote late, after another process took it over
   */
  epoch(epoch: number): void {
    this.leaseEpoch = epoch;
  }

  /**
   * Takes a file checkpoint with `take` before every user message the run writes from now on
   * ({@link saveUser}), given the id the entry is about to get, and names it in the entry's
   * metadata (`fileCheckpoint`). A checkpoint whose message could not be written is discarded
   */
  checkpoints(take: (entryId: string) => Promise<TakenCheckpoint | undefined>): void {
    this.checkpointer = take;
  }

  /** What the run's entries name in their metadata, see {@link tag} */
  get tagged(): string | undefined {
    return this.taggedRun;
  }

  /** The entry `message` became, when the run saved this very message */
  entryOf(message: Message): string | undefined {
    return this.entries.get(message);
  }

  /** How many entries the run wrote */
  get written(): number {
    return this.count;
  }

  /**
   * Stops every write from now on: the run lost its thread to another process (a durable run
   * another process took over), which writes there instead
   */
  seal(): void {
    this.sealed = true;
  }

  /**
   * Runs `check` before every write from now on, which fails the write by throwing: a durable run
   * confirms it still holds its lease, so a process that lost it never writes after the one that
   * took it over
   */
  guard(check: () => Promise<void>): void {
    this.check = check;
  }

  /** Resolves once every write asked for so far is done, failed ones included */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** Saves a message of the run, with `metadata` on its entry */
  save(
    agentId: string,
    message: Message,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    return this.write(agentId, message, toolCalls, toolResults, undefined, metadata);
  }

  /**
   * Saves a message the user sent (the input, a queued message), with `metadata` on its entry,
   * after the file checkpoint of the files as they are right before it, when the run takes them
   */
  saveUser(agentId: string, message: Message, metadata?: Record<string, unknown>): Promise<void> {
    return this.write(agentId, message, undefined, undefined, undefined, metadata, true);
  }

  /** Records an event of the session, with a note of it as its message */
  event(agentId: string, event: EntryEvent, note: string): Promise<void> {
    return this.write(agentId, { role: 'system', content: note }, undefined, undefined, event);
  }

  /** Where the run wrote, once it wrote anything */
  summary(): RunMemoryPlace | undefined {
    if (this.branchPoint === undefined) return undefined;
    return {
      threadId: this.threadId,
      branchPoint: this.branchPoint,
      ...(this.leafId !== undefined && { leafId: this.leafId }),
    };
  }

  /**
   * Whether a write may go on: the run is not sealed and its guard passes (it throws when the
   * run lost its lease). Asked right before the entry is added, after every wait of the write
   * (a file checkpoint, making the thread), as the run may lose its thread meanwhile, and before
   * a file checkpoint, so a run that lost it takes none. Answered at once, without a wait, for a
   * run without a guard, so its entries are written as soon as before
   */
  private mayWrite(): boolean | Promise<boolean> {
    if (this.sealed) return false;
    if (!this.check) return true;
    return this.check().then(() => !this.sealed);
  }

  private write(
    agentId: string,
    message: Message,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[],
    event?: EntryEvent,
    metadata?: Record<string, unknown>,
    fromUser = false
  ): Promise<void> {
    if (!this.opened || !this.enabled || this.sealed) return Promise.resolve();
    const options = this.options();
    const written = this.queue.then(async () => {
      if (this.sealed) return;
      let entryId: string | undefined;
      let fields = metadata;
      let checkpoint: TakenCheckpoint | undefined;
      if (fromUser && this.checkpointer) {
        const allowed = this.mayWrite();
        if (!(typeof allowed === 'boolean' ? allowed : await allowed)) return;
        const named = `entry_${nanoid(12)}`;
        checkpoint = await this.checkpointer(named);
        if (checkpoint) {
          entryId = named;
          fields = { ...fields, [FILE_CHECKPOINT_KEY]: checkpoint.ref };
        }
      }
      let entry: MemoryEntry | undefined;
      try {
        entry = await saveEntry(
          this.threadId,
          agentId,
          message,
          this.memory(),
          toolCalls,
          toolResults,
          options.onMemoryError,
          options.userId,
          this.place,
          event,
          this.taggedRun === undefined
            ? fields
            : {
                ...fields,
                durableRun: this.taggedRun,
                ...(this.leaseEpoch !== undefined && { durableEpoch: this.leaseEpoch }),
              },
          entryId,
          () => this.mayWrite()
        );
      } catch (error) {
        await checkpoint?.discard();
        throw error;
      }
      if (!entry) {
        await checkpoint?.discard();
        return;
      }
      this.entries.set(message, entry.id);
      this.count++;
      if (this.branchPoint === undefined) this.branchPoint = entry.parentId ?? null;
      this.leafId = entry.id;
      if (this.place.parentId !== undefined) this.place.parentId = entry.id;
      reportEntry(entry, options.onMemoryEntry);
    });
    this.queue = written.catch(() => undefined);
    return written;
  }
}

/** Hands a saved entry to `onMemoryEntry`, whose failure does not fail the write or the run */
function reportEntry(entry: MemoryEntry, onMemoryEntry: RunOptions['onMemoryEntry']): void {
  if (!onMemoryEntry) return;
  const warn = (error: unknown) =>
    getLogger().warn('onMemoryEntry failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  try {
    void Promise.resolve(onMemoryEntry(entry)).catch(warn);
  } catch (error) {
    warn(error);
  }
}
