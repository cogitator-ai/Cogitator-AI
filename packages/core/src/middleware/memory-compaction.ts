import {
  CompactionService,
  checkCompactionSettings,
  countEntryTokens,
  readCompactedHistory,
  sinceSummary,
  type SummarizeFn,
} from '@cogitator-ai/memory';
import type {
  CompactionResult,
  MemoryAdapter,
  MemoryCompactionConfig,
  RunEndEvent,
  RunMiddleware,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';

/** The run a compaction follows, which its calls are counted against and stop with */
export interface CompactionRun {
  runId: string;
  agentId: string;
  threadId: string;
  signal?: AbortSignal;
}

/** What the memory compaction middleware takes from the runtime */
export interface MemoryCompactionDeps {
  memory: () => MemoryAdapter | undefined;
  /** A summarizer that asks `model`, its calls counted against `run` */
  summarizer: (model: string, run: CompactionRun) => SummarizeFn;
  /** The context window `model` runs with */
  windowOf: (model: string) => number;
}

/** Turns since the last compaction under which a new one would only churn */
const THRASH_TURNS = 2;
/** How long a thread whose compaction failed is left alone, doubled on each failure in a row */
const RETRY_AFTER_MS = 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * Compacts a run's thread after the run, see `MemoryCompactionConfig`: once the conversation of
 * the branch the run wrote passes `at` of the context window of the model it ended on, the branch
 * is compacted `hierarchical`ly and the next run reads the summary and the kept tail. A run that
 * wrote aside of the active branch (a fork or a replay) is left alone. When the last compaction
 * was no more than two turns ago, compacting again would mean one huge output fills the
 * conversation, so it is skipped with a warning to clear tool outputs instead. A compaction that
 * fails is logged, the run keeps its result, and the thread is not compacted again for a minute,
 * twice as long after each failure in a row up to an hour, so a thread that cannot be compacted
 * does not pay for the attempt on every run.
 */
export function memoryCompactionMiddleware(
  config: MemoryCompactionConfig,
  deps: MemoryCompactionDeps
): RunMiddleware {
  const { at: share, beforeCompact, afterCompact, ...settings } = config;
  const at = share ?? 0.8;
  if (!(at > 0 && at <= 1)) {
    throw new Error(`memory.compaction.at must be above 0 and at most 1, got ${at}`);
  }
  checkCompactionSettings(settings);
  const failures = new Map<string, { until: number; wait: number }>();
  const forgetOld = (now: number) => {
    for (const [threadId, failure] of failures) {
      if (failure.until + RETRY_AFTER_MAX_MS < now) failures.delete(threadId);
    }
  };
  return {
    name: 'cogitator:memory-compaction',
    async afterRun({ result, model }: RunEndEvent, context) {
      const memory = deps.memory();
      const place = result.memory;
      if (!memory?.getPath || !place?.leafId || context.signal.aborted) return;
      if ((failures.get(place.threadId)?.until ?? 0) > Date.now()) return;
      const thread = await memory.getThread(place.threadId);
      if (!thread.success || thread.data?.activeLeafId !== place.leafId) return;

      const window = deps.windowOf(model);
      const threshold = Math.floor(window * at);
      const read = await readCompactedHistory(
        { getPath: memory.getPath.bind(memory) },
        { threadId: place.threadId, includeToolCalls: true }
      );
      if (!read.success) {
        getLogger().warn('Could not read the thread to compact it', {
          threadId: place.threadId,
          error: read.error,
        });
        return;
      }
      const tokens = read.data.reduce((sum, entry) => sum + countEntryTokens(entry), 0);
      if (tokens < threshold) return;
      if (read.data[0]?.type === 'compaction') {
        const turns = sinceSummary(read.data).filter(
          (entry) => entry.message.role === 'user'
        ).length;
        if (turns <= THRASH_TURNS) {
          getLogger().warn(
            'The thread outgrew its context again right after a compaction: clear tool outputs (context.clearToolOutputs) instead of compacting it again',
            { threadId: place.threadId, tokens, threshold }
          );
          return;
        }
      }

      let compacted: CompactionResult;
      try {
        const before = await beforeCompact?.({ threadId: place.threadId, tokens, threshold });
        if (before === false) return;
        const instructions = [settings.summaryPrompt, before?.instructions]
          .filter((part): part is string => !!part?.trim())
          .join('\n\n');
        const service = new CompactionService({
          adapter: memory,
          summarize: deps.summarizer(settings.summaryModel ?? model, {
            runId: result.runId,
            agentId: result.agentId,
            threadId: place.threadId,
            signal: context.signal,
          }),
        });
        const keepsTokens =
          settings.keepRecentTokens !== undefined || settings.keepRecent === undefined;
        compacted = await service.compact(place.threadId, {
          ...settings,
          strategy: 'hierarchical',
          threshold: 0,
          keepRecent: settings.keepRecent ?? 0,
          ...(keepsTokens && {
            keepRecentTokens: settings.keepRecentTokens ?? Math.min(20_000, Math.floor(window / 4)),
          }),
          ...(instructions && { summaryPrompt: instructions }),
        });
      } catch (error) {
        if (context.signal.aborted) {
          getLogger().warn('Compacting the thread stopped with its run', {
            threadId: place.threadId,
          });
          return;
        }
        const wait = Math.min(
          (failures.get(place.threadId)?.wait ?? RETRY_AFTER_MS / 2) * 2,
          RETRY_AFTER_MAX_MS
        );
        const now = Date.now();
        forgetOld(now);
        failures.set(place.threadId, { until: now + wait, wait });
        getLogger().warn('Could not compact the thread after a run', {
          threadId: place.threadId,
          retryInMs: wait,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      failures.delete(place.threadId);
      try {
        await afterCompact?.(compacted);
      } catch (error) {
        getLogger().warn('memory.compaction.afterCompact failed', {
          threadId: place.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
