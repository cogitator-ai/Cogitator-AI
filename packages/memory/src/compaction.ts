import {
  CONVERSATION_ENTRY_TYPES,
  type MemoryAdapter,
  type MemoryEntry,
  type MemoryEntryType,
  type MemoryResult,
  type CompactionConfig,
  type CompactionEvent,
  type CompactionResult,
  type CompactionStrategy,
  type Message,
} from '@cogitator-ai/types';
import { countEntryTokens, countMessagesTokens } from './token-counter';

/**
 * Summary settings taken from the `CompactionConfig` passed to `compact()`.
 */
export interface SummarizeOptions {
  /** `CompactionConfig.summaryModel`: the model that should write the summary. */
  model?: string;
  /** `CompactionConfig.summaryPrompt`: instructions for writing the summary. */
  prompt?: string;
}

/**
 * Turns the messages being compacted into summary text. `CompactionService` always passes the
 * `summaryModel` / `summaryPrompt` of the current compaction as `options`.
 */
export type SummarizeFn = (messages: Message[], options?: SummarizeOptions) => Promise<string>;

export interface CompactionServiceConfig {
  adapter: MemoryAdapter;
  summarize: SummarizeFn;
}

/** The entry types to read for a conversation that may have been compacted */
export const HISTORY_ENTRY_TYPES: readonly MemoryEntryType[] = [
  ...CONVERSATION_ENTRY_TYPES,
  'compaction',
];

function compactionOf(entry: MemoryEntry): CompactionEvent | undefined {
  if (entry.type !== 'compaction') return undefined;
  const event = entry.event as Partial<CompactionEvent> | undefined;
  return {
    firstKeptEntryId: typeof event?.firstKeptEntryId === 'string' ? event.firstKeptEntryId : null,
    ...(typeof event?.lastCompactedEntryId === 'string' && {
      lastCompactedEntryId: event.lastCompactedEntryId,
    }),
    compacted: typeof event?.compacted === 'number' ? event.compacted : 0,
    summarized: event?.summarized !== false,
  };
}

/**
 * The conversation a branch holds, read with {@link HISTORY_ENTRY_TYPES}: from its latest
 * compaction on, the summary followed by the entries that compaction kept and every entry after,
 * and a branch with no compaction as it is. `path` may be only the newest entries of the branch:
 * when it does not reach the first kept entry, every entry of it after the last left out one
 * counts, all of it when that one is not there either.
 */
export function compactedHistory(path: readonly MemoryEntry[]): MemoryEntry[] {
  let at = path.length - 1;
  while (at >= 0 && path[at]?.type !== 'compaction') at--;
  const conversation = (entries: readonly MemoryEntry[]) =>
    entries.filter((entry) => entry.type !== 'compaction');
  const latest = path[at];
  const compaction = latest && compactionOf(latest);
  if (!latest || !compaction) return conversation(path);
  const indexOf = (id: string | undefined) =>
    id === undefined ? -1 : path.findIndex((entry) => entry.id === id);
  const kept = indexOf(compaction.firstKeptEntryId ?? undefined);
  const lastLeftOut = indexOf(compaction.lastCompactedEntryId);
  const anchored =
    compaction.firstKeptEntryId !== null || compaction.lastCompactedEntryId !== undefined;
  const from = kept !== -1 ? kept : lastLeftOut !== -1 ? lastLeftOut + 1 : anchored ? 0 : at + 1;
  const rest = conversation(path.slice(from));
  return compaction.summarized ? [latest, ...rest] : rest;
}

/** Entries a {@link readCompactedHistory} page reads */
const HISTORY_PAGE = 200;

/**
 * Whether `path`, the newest entries of a branch read with {@link HISTORY_ENTRY_TYPES}, reaches
 * where its latest compaction goes on from, so entries before it do not count
 */
function reachesCompaction(path: readonly MemoryEntry[]): boolean {
  for (let at = path.length - 1; at >= 0; at--) {
    const entry = path[at];
    const compaction = entry && compactionOf(entry);
    if (!compaction) continue;
    const anchor = compaction.firstKeptEntryId ?? compaction.lastCompactedEntryId;
    return anchor === undefined || path.some((candidate) => candidate.id === anchor);
  }
  return false;
}

/**
 * The conversation of a branch as {@link compactedHistory} builds it, read in pages from its leaf
 * back to where its latest compaction goes on from, so a compacted thread costs what its
 * conversation holds, not everything it ever held. A branch with no compaction is read to its
 * root. `leafId` picks the branch, the active one by default.
 */
export async function readCompactedHistory(
  memory: Required<Pick<MemoryAdapter, 'getPath'>>,
  options: { threadId: string; leafId?: string; includeToolCalls?: boolean }
): Promise<MemoryResult<MemoryEntry[]>> {
  const pages: MemoryEntry[][] = [];
  let before: string | undefined;
  for (;;) {
    const page = await memory.getPath({
      threadId: options.threadId,
      ...(options.leafId !== undefined && { leafId: options.leafId }),
      ...(before !== undefined && { before }),
      limit: HISTORY_PAGE,
      types: HISTORY_ENTRY_TYPES,
      includeToolCalls: options.includeToolCalls ?? false,
    });
    if (!page.success) return page;
    pages.unshift(page.data);
    const first = page.data[0];
    if (!first || page.data.length < HISTORY_PAGE) break;
    if (reachesCompaction(pages.flat())) break;
    before = first.id;
  }
  return { success: true, data: compactedHistory(pages.flat()) };
}

/**
 * Compactions in progress, per adapter and thread: a second compaction of the same thread in this
 * process waits for the first and then looks at what is left, instead of summarizing the same
 * entries twice.
 */
const running = new WeakMap<MemoryAdapter, Map<string, Promise<unknown>>>();

export class CompactionService {
  private readonly adapter: MemoryAdapter;
  private readonly summarize: SummarizeFn;

  constructor(config: CompactionServiceConfig) {
    this.adapter = config.adapter;
    this.summarize = config.summarize;
  }

  /**
   * Compacts thread `sessionId` once it holds `config.threshold` tokens or
   * `config.messageThreshold` entries, keeping the newest `config.keepRecent` entries.
   */
  async compact(sessionId: string, config: CompactionConfig): Promise<CompactionResult> {
    if (config.threshold === undefined && config.messageThreshold === undefined) {
      throw new Error(
        'CompactionConfig needs threshold (tokens) or messageThreshold (entries) to know when to compact'
      );
    }

    let threads = running.get(this.adapter);
    if (!threads) {
      threads = new Map();
      running.set(this.adapter, threads);
    }
    const previous = threads.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.compactNow(sessionId, config));
    threads.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (threads.get(sessionId) === current) threads.delete(sessionId);
    }
  }

  private async compactNow(sessionId: string, config: CompactionConfig): Promise<CompactionResult> {
    const getPath = this.adapter.getPath?.bind(this.adapter);
    const entriesResult = getPath
      ? await readCompactedHistory({ getPath }, { threadId: sessionId, includeToolCalls: true })
      : await this.adapter.getEntries({ threadId: sessionId, includeToolCalls: true });
    if (!entriesResult.success) {
      throw new Error(`Failed to load entries: ${entriesResult.error}`);
    }

    const entries = entriesResult.data;
    const unchanged: CompactionResult = {
      sessionId,
      originalMessages: entries.length,
      compactedMessages: entries.length,
      summaryTokens: 0,
    };

    if (!reachedThreshold(entries, config) || entries.length <= config.keepRecent) {
      return unchanged;
    }

    const sorted = this.adapter.getPath
      ? entries
      : [...entries].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );

    const strategy = strategies[config.strategy];
    return strategy(this, sessionId, sorted, config);
  }

  /**
   * Puts `summary` in place of `entriesToRemove`. On an adapter with branches it adds a
   * `compaction` entry to the active branch that leaves them out of the conversation from the
   * first of `entriesToKeep` on (see {@link compactedHistory}) and deletes nothing. On any other
   * adapter it adds the summary dated just before the first kept entry and deletes the summarized
   * ones, re-adding the kept entries after the summary when the adapter ignores `createdAt`.
   */
  async applySummary(
    sessionId: string,
    entriesToRemove: MemoryEntry[],
    summary: string,
    entriesToKeep: MemoryEntry[] = []
  ): Promise<number> {
    const summaryMessage: Message = {
      role: 'system',
      content: `[Conversation summary]\n${summary}`,
    };

    const summaryTokens = countMessagesTokens([summaryMessage]);
    if (this.adapter.getPath) {
      await this.addCompaction(sessionId, summaryMessage, summaryTokens, {
        firstKeptEntryId: entriesToKeep[0]?.id ?? null,
        ...lastOf(entriesToRemove),
        compacted: entriesToRemove.length,
        summarized: true,
      });
      return summaryTokens;
    }
    const placeAt = summaryTimestamp(entriesToRemove, entriesToKeep);

    const added = await this.adapter.addEntry({
      threadId: sessionId,
      message: summaryMessage,
      tokenCount: summaryTokens,
      metadata: { compactionSummary: true, compactedAt: new Date().toISOString() },
      ...(placeAt && { createdAt: placeAt }),
    });
    if (!added.success) {
      throw new Error(`Failed to store compaction summary: ${added.error}`);
    }

    const placed = timeOf(added.data.createdAt) === placeAt?.getTime();
    if (!placed) {
      for (const entry of entriesToKeep) {
        const readded = await this.adapter.addEntry({
          threadId: entry.threadId,
          message: entry.message,
          toolCalls: entry.toolCalls,
          toolResults: entry.toolResults,
          tokenCount: entry.tokenCount,
          metadata: entry.metadata,
        });
        if (!readded.success) {
          throw new Error(`Failed to reorder entries after compaction: ${readded.error}`);
        }
        await this.adapter.deleteEntry(entry.id);
      }
    }

    for (const entry of entriesToRemove) {
      await this.adapter.deleteEntry(entry.id);
    }

    return summaryTokens;
  }

  /**
   * Leaves `entriesToDrop` out of the conversation without a summary: a `compaction` entry on an
   * adapter with branches, deleting them on any other
   */
  async dropEntries(
    sessionId: string,
    entriesToDrop: MemoryEntry[],
    entriesToKeep: MemoryEntry[]
  ): Promise<void> {
    if (this.adapter.getPath) {
      await this.addCompaction(
        sessionId,
        { role: 'system', content: `[${entriesToDrop.length} earlier entries left out]` },
        0,
        {
          firstKeptEntryId: entriesToKeep[0]?.id ?? null,
          ...lastOf(entriesToDrop),
          compacted: entriesToDrop.length,
          summarized: false,
        }
      );
      return;
    }
    for (const entry of entriesToDrop) {
      await this.adapter.deleteEntry(entry.id);
    }
  }

  /**
   * Adds the `compaction` entry after the active leaf while the entry it goes on from (the first
   * kept, else the last left out) is on the active branch, checked before the write and on the
   * written entry's own branch after it, which it is removed from when the leaf moved in
   * between: a run on another branch would otherwise get a summary of a conversation it never
   * had.
   */
  private async addCompaction(
    sessionId: string,
    message: Message,
    tokenCount: number,
    event: CompactionEvent
  ): Promise<void> {
    const anchor = event.firstKeptEntryId ?? event.lastCompactedEntryId;
    if (!this.adapter.getPath) throw new Error('A compaction entry needs an adapter with branches');
    const getPath = this.adapter.getPath.bind(this.adapter);
    const moved = () =>
      new Error(
        `The active branch of ${sessionId} changed while it was compacted, compact it again`
      );
    const onBranch = async (leafId?: string) => {
      if (anchor === undefined) return true;
      const path = await getPath({
        threadId: sessionId,
        types: 'all',
        ...(leafId !== undefined && { leafId }),
      });
      if (!path.success) throw new Error(`Failed to read the thread: ${path.error}`);
      return path.data.some((entry) => entry.id === anchor);
    };
    if (!(await onBranch())) throw moved();
    const added = await this.adapter.addEntry({
      threadId: sessionId,
      type: 'compaction',
      message,
      tokenCount,
      event: { ...event },
      metadata: { compactionSummary: event.summarized, compactedAt: new Date().toISOString() },
    });
    if (!added.success) {
      throw new Error(`Failed to store compaction summary: ${added.error}`);
    }
    if (!(await onBranch(added.data.id))) {
      await this.adapter.deleteEntry(added.data.id);
      throw moved();
    }
  }

  getSummarizeFn(): SummarizeFn {
    return this.summarize;
  }

  getAdapter(): MemoryAdapter {
    return this.adapter;
  }
}

function lastOf(entries: readonly MemoryEntry[]): { lastCompactedEntryId?: string } {
  const last = entries.at(-1);
  return last ? { lastCompactedEntryId: last.id } : {};
}

function timeOf(value: Date | string): number {
  return new Date(value).getTime();
}

/** Whether the thread holds enough tokens or entries to be compacted. */
function reachedThreshold(entries: MemoryEntry[], config: CompactionConfig): boolean {
  if (config.messageThreshold !== undefined && entries.length >= config.messageThreshold) {
    return true;
  }
  if (config.threshold === undefined) return false;
  const totalTokens = entries.reduce((sum, e) => sum + countEntryTokens(e), 0);
  return totalTokens >= config.threshold;
}

/**
 * When the summary goes: a millisecond before the first kept entry, or at the time of the last
 * removed entry when nothing is kept. Entries saved while the summary was written are newer and
 * stay after it.
 */
function summaryTimestamp(removed: MemoryEntry[], kept: MemoryEntry[]): Date | undefined {
  const firstKept = kept[0];
  if (firstKept) return new Date(new Date(firstKept.createdAt).getTime() - 1);
  const lastRemoved = removed.at(-1);
  return lastRemoved ? new Date(lastRemoved.createdAt) : undefined;
}

type StrategyFn = (
  service: CompactionService,
  sessionId: string,
  entries: MemoryEntry[],
  config: CompactionConfig
) => Promise<CompactionResult>;

const summaryStrategy: StrategyFn = async (service, sessionId, entries, config) => {
  const splitAt = entries.length - config.keepRecent;
  const oldEntries = entries.slice(0, splitAt);
  const recentEntries = entries.slice(splitAt);
  const oldMessages = oldEntries.map((e) => e.message);

  const summary = await service.getSummarizeFn()(oldMessages, {
    model: config.summaryModel,
    prompt: config.summaryPrompt,
  });
  const summaryTokens = await service.applySummary(sessionId, oldEntries, summary, recentEntries);

  return {
    sessionId,
    originalMessages: entries.length,
    compactedMessages: config.keepRecent + 1,
    summaryTokens,
  };
};

const slidingWindowStrategy: StrategyFn = async (service, sessionId, entries, config) => {
  const splitAt = entries.length - config.keepRecent;
  const oldEntries = entries.slice(0, splitAt);

  await service.dropEntries(sessionId, oldEntries, entries.slice(splitAt));

  return {
    sessionId,
    originalMessages: entries.length,
    compactedMessages: config.keepRecent,
    summaryTokens: 0,
  };
};

const hybridStrategy: StrategyFn = async (service, sessionId, entries, config) => {
  const splitAt = entries.length - config.keepRecent;
  const oldEntries = entries.slice(0, splitAt);

  if (oldEntries.length <= 5) {
    return slidingWindowStrategy(service, sessionId, entries, config);
  }

  return summaryStrategy(service, sessionId, entries, config);
};

const strategies: Record<CompactionStrategy, StrategyFn> = {
  summary: summaryStrategy,
  'sliding-window': slidingWindowStrategy,
  hybrid: hybridStrategy,
};
