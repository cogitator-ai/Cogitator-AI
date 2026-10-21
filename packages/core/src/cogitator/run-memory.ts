import type {
  MemoryAdapter,
  Message,
  RunMemoryPlace,
  RunOptions,
  ToolCall,
  ToolResult,
} from '@cogitator-ai/types';
import { saveEntry, type EntryEvent, type EntryPlacement } from './message-builder';

/**
 * What a run writes to its thread's memory, in the order it writes it. A run on a branch
 * (`RunOptions.branch`) chains its entries after the branch point; any other run adds after the
 * thread's active leaf. Writes and session events go one after another, so an event recorded
 * from a callback still lands before the entries that follow it.
 */
export class RunMemory {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly place: EntryPlacement;
  private branchPoint: string | null | undefined;
  private leafId: string | undefined;

  /**
   * @param memory the runtime's memory adapter when it writes, read then: memory connects
   *   after a run starts
   */
  constructor(
    private readonly memory: () => MemoryAdapter | undefined,
    private readonly threadId: string,
    private readonly options: RunOptions,
    resumed?: { parentId: string | null; activate: boolean }
  ) {
    const branch = options.branch;
    this.place = resumed
      ? { ...resumed }
      : branch
        ? { parentId: branch.fromEntryId, activate: branch.activate ?? true }
        : {};
  }

  /** Whether the run saves to memory */
  get enabled(): boolean {
    return (
      this.memory() !== undefined &&
      this.options.saveHistory !== false &&
      this.options.useMemory !== false
    );
  }

  /** Where the run's next entry goes, for a paused run to go on along its branch */
  get placement(): { parentId: string | null; activate: boolean } | undefined {
    if (this.place.parentId === undefined) return undefined;
    return { parentId: this.place.parentId, activate: this.place.activate ?? true };
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
    if (!this.enabled) return Promise.resolve();
    const written = this.queue.then(async () => {
      const entry = await saveEntry(
        this.threadId,
        agentId,
        message,
        this.memory(),
        toolCalls,
        toolResults,
        this.options.onMemoryError,
        this.options.userId,
        this.place,
        event
      );
      if (!entry) return;
      if (this.branchPoint === undefined) this.branchPoint = entry.parentId ?? null;
      this.leafId = entry.id;
      if (this.place.parentId !== undefined) this.place.parentId = entry.id;
    });
    this.queue = written;
    return written;
  }
}
