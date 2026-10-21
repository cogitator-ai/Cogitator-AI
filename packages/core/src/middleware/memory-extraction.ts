import {
  ExtractionAnswerError,
  MemoryExtractor,
  MemoryItems,
  WindowError,
  isMemoryItemAdapter,
  isTimeZone,
  type SummarizeFn,
} from '@cogitator-ai/memory';
import type {
  MemoryAdapter,
  MemoryEntry,
  MemoryExtractionConfig,
  MemoryItemScope,
  MemoryResult,
  RunEndEvent,
  RunMiddleware,
  RunMiddlewareContext,
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
/** Extractions in a row a window may fail before the next one goes on without it */
const WINDOW_ATTEMPTS = 3;
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
): Promise<{ entries: MemoryEntry[]; found: boolean }> {
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
    if (stop !== -1) return { entries: [...page.data.slice(stop + 1), ...read], found: true };
    read.unshift(...page.data);
    const first = page.data[0];
    if (!first || page.data.length < PAGE) break;
    before = first.id;
  }
  if (cursor === null) return { entries: read, found: true };
  if (branchPoint === null) return { entries: read, found: false };
  const after = read.findIndex((entry) => entry.id === branchPoint);
  return { entries: read.slice(after + 1), found: false };
}

/**
 * Whether `leafId` lies on the thread's active branch: it is the active leaf, or runs of the
 * thread that ran at the same time appended after it. A run on another branch (a fork, a replay)
 * does not.
 */
export async function onActivePath(
  memory: Required<Pick<MemoryAdapter, 'getPath'>>,
  threadId: string,
  activeLeafId: string | null | undefined,
  leafId: string
): Promise<boolean> {
  if (activeLeafId === leafId) return true;
  if (!activeLeafId) return false;
  const path = await memory.getPath({ threadId, leafId: activeLeafId, limit: PAGE });
  return path.success && path.data.some((entry) => entry.id === leafId);
}

/** Where extraction stands on a thread, as its metadata keeps it */
interface ExtractionCursor {
  /** The last entry extracted, `null` to start from the thread's first entry */
  through: string | null;
  /** Extractions in a row the model could not answer the same window of */
  failures?: number;
  /** The last entry of that window */
  failedThrough?: string;
}

/** Where extraction stands on a thread, undefined when the thread was never extracted */
function cursorOf(metadata: Record<string, unknown> | undefined): ExtractionCursor | undefined {
  const cursor = metadata?.[EXTRACTION_CURSOR];
  if (typeof cursor !== 'object' || cursor === null) return undefined;
  const { through, failures, failedThrough } = cursor as {
    through?: unknown;
    failures?: unknown;
    failedThrough?: unknown;
  };
  if (typeof through !== 'string' && through !== null) return undefined;
  return {
    through,
    ...(typeof failures === 'number' && { failures }),
    ...(typeof failedThrough === 'string' && { failedThrough }),
  };
}

function unwrapUpdate(result: MemoryResult<unknown>): void {
  if (!result.success) throw new Error(result.error);
}

/**
 * Extracts memory items from a run's conversation after the run, see `MemoryExtractionConfig`:
 * the entries of the active branch written since the last extraction (whose last entry the
 * thread keeps in `metadata.memoryExtraction`), or for a first extraction the run's own, read in
 * windows by the extraction model and written through `MemoryItems`, so items are grounded,
 * trusted by who said them and only added. The thread keeps its place after every window, so a
 * failure later on does not read the earlier windows again, and a window the model could not
 * answer in three extractions in a row is left out with a warning instead of holding the thread
 * back. A provider or storage failure never leaves a window out. Runs of
 * one thread extract one after another. A first extraction that fails marks where it started,
 * so the next one takes those entries too. The items are kept under the agent's memory id (its
 * configured id, else its name) and the run's user. A run without a user keeps its items to its thread, so
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
  const extracting = new Map<string, Promise<void>>();
  return {
    name: 'cogitator:memory-extraction',
    async afterRun(event: RunEndEvent, context) {
      const threadId = event.result.memory?.threadId;
      if (threadId === undefined) return;
      const before = extracting.get(threadId) ?? Promise.resolve();
      const run = before.then(() => extract(event, context));
      const settled = run.catch(() => undefined);
      extracting.set(threadId, settled);
      try {
        await run;
      } finally {
        if (extracting.get(threadId) === settled) extracting.delete(threadId);
      }
    },
  };

  async function extract(
    { result, model, memoryAgentId }: RunEndEvent,
    context: RunMiddlewareContext
  ): Promise<void> {
    const memory = deps.memory();
    const place = result.memory;
    if (!memory?.getPath || !isMemoryItemAdapter(memory) || !place?.leafId) return;
    const getPath = memory.getPath.bind(memory);
    const leafId = place.leafId;
    if (context.signal.aborted) return;
    if ((failures.get(place.threadId)?.until ?? 0) > Date.now()) return;
    const thread = await memory.getThread(place.threadId);
    if (!thread.success || !thread.data) return;
    const onActive = await onActivePath(
      { getPath: memory.getPath.bind(memory) },
      place.threadId,
      thread.data.activeLeafId,
      place.leafId
    );
    if (!onActive) return;
    const metadata = thread.data.metadata;
    const userId = context.userId;
    const anonymous = config.scope !== 'agent' && userId === undefined;
    const scope: MemoryItemScope = {
      agentId: memoryAgentId,
      ...(config.scope !== 'agent' && userId !== undefined && { userId }),
      ...((config.scope === 'thread' || anonymous) && { threadId: place.threadId }),
    };
    const timeZone =
      typeof metadata.timeZone === 'string' && isTimeZone(metadata.timeZone)
        ? metadata.timeZone
        : (config.timeZone ?? 'UTC');
    const stored = cursorOf(metadata);
    let through = stored?.through;
    let held = stored;
    const keep = (position: string | null, failure?: { failures: number; failedThrough: string }) =>
      memory.updateThread(place.threadId, {
        [EXTRACTION_CURSOR]: { through: position, at: new Date().toISOString(), ...failure },
      });

    try {
      const { entries, found } = await newEntries(
        { getPath: memory.getPath.bind(memory) },
        place.threadId,
        place.leafId,
        through,
        place.branchPoint
      );
      if (!found) {
        through = place.branchPoint;
        held = undefined;
      }
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
      const written = await extractor.extract(
        entries,
        { scope, timeZone },
        {
          beforeWindow: async () => {
            const now = await memory.getThread(place.threadId);
            return (
              now.success &&
              now.data !== null &&
              (await onActivePath({ getPath }, place.threadId, now.data.activeLeafId, leafId))
            );
          },
          onWindow: async (own) => {
            const last = own.at(-1);
            if (!last) return;
            through = last.id;
            held = undefined;
            unwrapUpdate(await keep(last.id));
          },
          skip: (error, own, index) => {
            if (index > 0 || !(error instanceof ExtractionAnswerError) || context.signal.aborted) {
              return false;
            }
            const stuck =
              held?.failedThrough === own.at(-1)?.id &&
              (held?.failures ?? 0) >= WINDOW_ATTEMPTS - 1;
            if (!stuck) return false;
            getLogger().warn('Skipped a window that failed memory extraction again and again', {
              threadId: place.threadId,
              from: own[0]?.id,
              to: own.at(-1)?.id,
              error: error.message,
            });
            return true;
          },
        }
      );
      const last = entries.at(-1);
      if (last && through !== last.id) unwrapUpdate(await keep(last.id));
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
      if (context.signal.aborted) return;
      const position = through === undefined ? place.branchPoint : through;
      const window = error instanceof WindowError ? error.own.at(-1)?.id : undefined;
      const failure =
        window !== undefined
          ? {
              failures: held?.failedThrough === window ? (held.failures ?? 0) + 1 : 1,
              failedThrough: window,
            }
          : held?.failedThrough !== undefined && held.failures !== undefined
            ? { failures: held.failures, failedThrough: held.failedThrough }
            : undefined;
      await keep(position, failure).catch(() => undefined);
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
  }
}
