import type {
  MemoryAdapter,
  MemoryEntry,
  CompactionConfig,
  CompactionResult,
  CompactionStrategy,
  Message,
} from '@cogitator-ai/types';
import { countMessagesTokens } from './token-counter';

export type SummarizeFn = (messages: Message[]) => Promise<string>;

export interface CompactionServiceConfig {
  adapter: MemoryAdapter;
  summarize: SummarizeFn;
}

export class CompactionService {
  private readonly adapter: MemoryAdapter;
  private readonly summarize: SummarizeFn;

  constructor(config: CompactionServiceConfig) {
    this.adapter = config.adapter;
    this.summarize = config.summarize;
  }

  async compact(sessionId: string, config: CompactionConfig): Promise<CompactionResult> {
    const entriesResult = await this.adapter.getEntries({ threadId: sessionId });
    if (!entriesResult.success) {
      throw new Error(`Failed to load entries: ${entriesResult.error}`);
    }

    const entries = entriesResult.data;
    if (entries.length <= config.keepRecent) {
      return {
        sessionId,
        originalMessages: entries.length,
        compactedMessages: entries.length,
        summaryTokens: 0,
      };
    }

    const strategy = strategies[config.strategy];
    return strategy(this, sessionId, entries, config);
  }

  async applySummary(
    sessionId: string,
    entriesToRemove: MemoryEntry[],
    summary: string
  ): Promise<number> {
    for (const entry of entriesToRemove) {
      await this.adapter.deleteEntry(entry.id);
    }

    const summaryMessage: Message = {
      role: 'system',
      content: `[Conversation summary]\n${summary}`,
    };

    const summaryTokens = countMessagesTokens([summaryMessage]);

    await this.adapter.addEntry({
      threadId: sessionId,
      message: summaryMessage,
      tokenCount: summaryTokens,
      metadata: { compactionSummary: true, compactedAt: new Date().toISOString() },
    });

    return summaryTokens;
  }

  getSummarizeFn(): SummarizeFn {
    return this.summarize;
  }

  getAdapter(): MemoryAdapter {
    return this.adapter;
  }
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
  const oldMessages = oldEntries.map((e) => e.message);

  const summary = await service.getSummarizeFn()(oldMessages);
  const summaryTokens = await service.applySummary(sessionId, oldEntries, summary);

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
