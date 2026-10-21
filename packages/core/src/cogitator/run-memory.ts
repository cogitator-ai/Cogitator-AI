import type {
  MemoryAdapter,
  Message,
  RunCheckpoint,
  RunMemoryPlace,
  RunOptions,
  ToolCall,
  ToolResult,
} from '@cogitator-ai/types';
import { saveEntry, type EntryEvent, type EntryPlacement } from './message-builder';

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

  /** Where the run keeps its conversation, once it may use memory: its thread and newest entry */
  get conversation(): { threadId: string; leafId?: string } | undefined {
    if (!this.opened || !this.enabled) return undefined;
    return { threadId: this.threadId, ...(this.leafId !== undefined && { leafId: this.leafId }) };
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

  /** Saves a message of the run */
  save(
    agentId: string,
    message: Message,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[]
  ): Promise<void> {
    return this.write(agentId, message, toolCalls, toolResults);
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

  private write(
    agentId: string,
    message: Message,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[],
    event?: EntryEvent
  ): Promise<void> {
    if (!this.opened || !this.enabled) return Promise.resolve();
    const options = this.options();
    const written = this.queue.then(async () => {
      const entry = await saveEntry(
        this.threadId,
        agentId,
        message,
        this.memory(),
        toolCalls,
        toolResults,
        options.onMemoryError,
        options.userId,
        this.place,
        event
      );
      if (!entry) return;
      if (this.branchPoint === undefined) this.branchPoint = entry.parentId ?? null;
      this.leafId = entry.id;
      if (this.place.parentId !== undefined) this.place.parentId = entry.id;
    });
    this.queue = written.catch(() => undefined);
    return written;
  }
}
