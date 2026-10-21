import {
  MemoryExtractor,
  MemoryItems,
  isMemoryItemAdapter,
  isTimeZone,
  type SummarizeFn,
} from '@cogitator-ai/memory';
import type {
  MemoryAdapter,
  MemoryEntry,
  MemoryExtractionConfig,
  MemoryItemScope,
  RunEndEvent,
  RunMiddleware,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import type { CompactionRun } from './memory-compaction';

/** What the memory extraction middleware takes from the runtime */
export interface MemoryExtractionDeps {
  memory: () => MemoryAdapter | undefined;
  /** A summarizer that asks `model`, its calls counted against `run` */
  summarizer: (model: string, run: CompactionRun) => SummarizeFn;
}

/** The thread metadata key that holds the last entry extracted */
export const EXTRACTION_CURSOR = 'memoryExtraction';

/** Entries read from the path at once while looking for where the last extraction stopped */
const PAGE = 200;
const RETRY_AFTER_MS = 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

/**
 * The entries of the path to `leafId` after `cursor` (the whole path for a `null` cursor, one
 * set before anything was extracted), or when the path does not hold it (a first extraction,
 * another branch), after `branchPoint`, the entry the run went after
 */
async function newEntries(
  memory: Required<Pick<MemoryAdapter, 'getPath'>>,
  threadId: string,
  leafId: string,
  cursor: string | null | undefined,
  branchPoint: string | null
): Promise<MemoryEntry[]> {
  const read: MemoryEntry[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await memory.getPath({
      threadId,
      leafId,
      limit: PAGE,
      includeToolCalls: true,
      ...(before !== undefined && { before }),
    });
    if (!page.success) throw new Error(page.error);
    const stop =
      cursor === undefined || cursor === null
        ? -1
        : page.data.findIndex((entry) => entry.id === cursor);
    if (stop !== -1) return [...page.data.slice(stop + 1), ...read];
    read.unshift(...page.data);
    const first = page.data[0];
    if (!first || page.data.length < PAGE) break;
    before = first.id;
  }
  if (cursor === null || branchPoint === null) return read;
  const after = read.findIndex((entry) => entry.id === branchPoint);
  return read.slice(after + 1);
}

/**
 * The last entry extracted from a thread, `null` when extraction is to start from the thread's
 * first entry, undefined when the thread was never extracted
 */
function cursorOf(metadata: Record<string, unknown> | undefined): string | null | undefined {
  const cursor = metadata?.[EXTRACTION_CURSOR];
  if (typeof cursor !== 'object' || cursor === null) return undefined;
  const through = (cursor as { through?: unknown }).through;
  return typeof through === 'string' || through === null ? through : undefined;
}

/**
 * Extracts memory items from a run's conversation after the run, see `MemoryExtractionConfig`:
 * the entries of the active branch written since the last extraction (whose last entry the
 * thread keeps in `metadata.memoryExtraction`), or for a first extraction the run's own, read in
 * windows by the extraction model and written through `MemoryItems`, so items are grounded,
 * trusted by who said them and only added. A first extraction that fails marks where it started,
 * so the next one takes those entries too. A run without a user keeps its items to its thread, so
 * visitors never share them. A run aside of the active branch, an aborted run and a memory that
 * stores no items are left alone. An extraction that fails is logged, the run keeps
 * its result, and the thread is left alone for a minute, twice as long after each failure in a
 * row up to an hour.
 */
export function memoryExtractionMiddleware(
  config: MemoryExtractionConfig,
  deps: MemoryExtractionDeps
): RunMiddleware {
  const windowTokens = config.windowTokens;
  if (windowTokens !== undefined && !(Number.isInteger(windowTokens) && windowTokens > 0)) {
    throw new Error(
      `memory.extraction.windowTokens must be a whole number above 0, got ${windowTokens}`
    );
  }
  const activation = config.activationConfidence;
  if (activation !== undefined && !(activation >= 0 && activation <= 1)) {
    throw new Error(
      `memory.extraction.activationConfidence must be from 0 to 1, got ${activation}`
    );
  }
  const failures = new Map<string, { until: number; wait: number }>();
  return {
    name: 'cogitator:memory-extraction',
    async afterRun({ result, model }: RunEndEvent, context) {
      const memory = deps.memory();
      const place = result.memory;
      if (!memory?.getPath || !isMemoryItemAdapter(memory) || !place?.leafId) return;
      if (context.signal.aborted) return;
      if ((failures.get(place.threadId)?.until ?? 0) > Date.now()) return;
      const thread = await memory.getThread(place.threadId);
      if (!thread.success || thread.data?.activeLeafId !== place.leafId) return;
      const metadata = thread.data.metadata;
      const userId =
        context.userId ?? (typeof metadata.userId === 'string' ? metadata.userId : undefined);
      const anonymous = config.scope !== 'agent' && userId === undefined;
      const scope: MemoryItemScope = {
        agentId: result.agentId,
        ...(config.scope !== 'agent' && userId !== undefined && { userId }),
        ...((config.scope === 'thread' || anonymous) && { threadId: place.threadId }),
      };
      const timeZone =
        typeof metadata.timeZone === 'string' && isTimeZone(metadata.timeZone)
          ? metadata.timeZone
          : (config.timeZone ?? 'UTC');
      const cursor = cursorOf(metadata);

      try {
        const entries = await newEntries(
          { getPath: memory.getPath.bind(memory) },
          place.threadId,
          place.leafId,
          cursor,
          place.branchPoint
        );
        if (entries.length === 0) return;
        const extractor = new MemoryExtractor({
          items: new MemoryItems({
            adapter: memory,
            ...(activation !== undefined && { activationConfidence: activation }),
          }),
          summarize: deps.summarizer(config.model ?? model, {
            runId: result.runId,
            agentId: result.agentId,
            threadId: place.threadId,
            signal: context.signal,
          }),
          ...(config.prompt && { prompt: config.prompt }),
          ...(windowTokens !== undefined && { windowTokens }),
        });
        const written = await extractor.extract(entries, { scope, timeZone });
        const last = entries.at(-1);
        if (last) {
          await memory.updateThread(place.threadId, {
            [EXTRACTION_CURSOR]: { through: last.id, at: new Date().toISOString() },
          });
        }
        failures.delete(place.threadId);
        try {
          await config.afterExtract?.(written);
        } catch (error) {
          getLogger().warn('memory.extraction.afterExtract failed', {
            threadId: place.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        if (cursor === undefined) {
          await memory
            .updateThread(place.threadId, {
              [EXTRACTION_CURSOR]: { through: place.branchPoint, at: new Date().toISOString() },
            })
            .catch(() => undefined);
        }
        if (context.signal.aborted) return;
        const wait = Math.min(
          (failures.get(place.threadId)?.wait ?? RETRY_AFTER_MS / 2) * 2,
          RETRY_AFTER_MAX_MS
        );
        const now = Date.now();
        for (const [threadId, failure] of failures) {
          if (failure.until + RETRY_AFTER_MAX_MS < now) failures.delete(threadId);
        }
        failures.set(place.threadId, { until: now + wait, wait });
        getLogger().warn('Could not extract memory items after a run', {
          threadId: place.threadId,
          retryInMs: wait,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
