import type {
  MemoryAdapter,
  MemoryEntry,
  CompactionConfig,
  CompactionResult,
  CompactionStrategy,
  Message,
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
    const entriesResult = await this.adapter.getEntries({
      threadId: sessionId,
      includeToolCalls: true,
    });
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

    const sorted = [...entries].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    const strategy = strategies[config.strategy];
    return strategy(this, sessionId, sorted, config);
  }

  /**
   * Replaces `entriesToRemove` with a summary entry dated just before the first of
   * `entriesToKeep`, so the thread reads summary, kept entries, then whatever was saved while the
   * summary was written. Kept entries are left untouched. An adapter that ignores the requested
   * `createdAt` gets the kept entries re-added after the summary instead.
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

  getSummarizeFn(): SummarizeFn {
    return this.summarize;
  }

  getAdapter(): MemoryAdapter {
    return this.adapter;
  }
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

  for (const entry of oldEntries) {
    await service.getAdapter().deleteEntry(entry.id);
  }

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
