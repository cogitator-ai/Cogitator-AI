import {
  MemoryBriefer,
  MAX_BRIEF_CARDS,
  MemoryItems,
  MemoryRetriever,
  briefBlock,
  calendarDate,
  isMemoryItemAdapter,
  withoutTurnContext,
  type BriefSource,
  type SummarizeFn,
} from '@cogitator-ai/memory';
import { CONVERSATION_ENTRY_TYPES } from '@cogitator-ai/types';
import type {
  MemoryAdapter,
  MemoryBriefConfig,
  MemoryEntry,
  Message,
  ModelTurnEvent,
  ModelTurnUpdate,
  RunMiddleware,
  RunMiddlewareContext,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { addToTurnContext } from '../cogitator/message-builder';
import type { CompactionRun } from './memory-compaction';

/** Sources a brief is written from at most: the best of what memory found */
const BRIEF_SOURCES = 12;

const CONVERSATION = new Set<string>(CONVERSATION_ENTRY_TYPES);

/**
 * `work`, or a failure once `signal` aborts, whichever comes first: the turn goes on without
 * the brief while a slow read of memory or call of the model is still under way
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('The memory brief timed out'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Where a run keeps its conversation, as the runtime names it */
export interface BriefPlace {
  threadId: string;
  leafId?: string | null;
  /** The entry the run's own entries follow, once it saved one */
  ownAfter?: string | null;
}

/** What the brief middleware takes from the runtime */
export interface MemoryBriefDeps {
  memory: () => MemoryAdapter | undefined;
  /** A summarizer that asks `model`, its calls counted against `run` */
  summarizer: (model: string, run: CompactionRun) => SummarizeFn;
  /** Where the run keeps its conversation, undefined for a run the runtime let into no thread */
  placeOf: (runId: string) => BriefPlace | undefined;
}

function textOf(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

function dayOf(date: Date): string {
  const { year, month, day } = calendarDate(date, 'UTC');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * `memory.brief`: before the first model call of a run, a cheap model reads what memory finds for
 * the input (earlier turns of the run's branch and the memory items it sees, ranked as the
 * `hybrid` context ranks them) and writes 0 to 4 cards, each quoting its source word for word.
 * The cards go into the turn's memory context as a hint that may be wrong. A run without memory,
 * small talk, a timeout or any failure leaves the turn as it was.
 */
export function memoryBriefMiddleware(
  config: MemoryBriefConfig,
  deps: MemoryBriefDeps
): RunMiddleware {
  const timeoutMs = config.timeoutMs ?? 4000;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`memory.brief.timeoutMs must be above 0, got ${config.timeoutMs}`);
  }
  if (
    config.maxTokens !== undefined &&
    !(Number.isInteger(config.maxTokens) && config.maxTokens > 0)
  ) {
    throw new Error(
      `memory.brief.maxTokens must be a whole number above 0, got ${config.maxTokens}`
    );
  }
  const maxCards = config.maxCards;
  if (
    maxCards !== undefined &&
    !(Number.isInteger(maxCards) && maxCards >= 1 && maxCards <= MAX_BRIEF_CARDS)
  ) {
    throw new Error(
      `memory.brief.maxCards must be a whole number from 1 to ${MAX_BRIEF_CARDS}, got ${maxCards}`
    );
  }
  const retriever = new MemoryRetriever();
  return {
    name: 'cogitator:memory-brief',
    async beforeModel(event, context) {
      if (context.iteration !== 1) return;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        return await untilAborted(brief(event, context, signal), signal);
      } catch (error) {
        if (context.signal.aborted) return;
        getLogger().warn('The memory brief was left out of the turn', {
          runId: context.runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    },
  };

  async function brief(
    event: ModelTurnEvent,
    context: RunMiddlewareContext,
    signal: AbortSignal
  ): Promise<ModelTurnUpdate | undefined> {
    const memory = deps.memory();
    const place = deps.placeOf(context.runId);
    const agentId = context.memoryAgentId;
    if (!memory || !place || agentId === undefined) return undefined;
    let at = event.messages.length - 1;
    while (at >= 0 && event.messages[at]?.role !== 'user') at--;
    const asked = event.messages[at];
    if (!asked) return undefined;
    const input = withoutTurnContext(textOf(asked)).trim();
    if (!input) return undefined;

    const { history, own } = await turnsOf(memory, place);
    const itemAdapter = isMemoryItemAdapter(memory) ? memory : undefined;
    const retrieval = await retriever.retrieve({
      input,
      anchor: new Date(),
      history,
      held: own,
      ...(itemAdapter && {
        items: new MemoryItems({ adapter: itemAdapter }),
        itemAdapter,
        scope: {
          agentId,
          ...(context.userId !== undefined && { userId: context.userId }),
          threadId: place.threadId,
        },
        agentIds: [context.agentId],
      }),
    });
    const sources: BriefSource[] = retrieval.hits.slice(0, BRIEF_SOURCES).map((hit) =>
      hit.kind === 'item'
        ? {
            ref: `item:${hit.hit.item.id}`,
            text: hit.hit.item.content,
            date: dayOf(hit.hit.item.recordedAt),
          }
        : {
            ref: `turn:${hit.hit.entry.id}`,
            text: textOf(hit.hit.entry.message),
            date: dayOf(hit.hit.entry.createdAt),
          }
    );
    if (sources.length === 0) return undefined;

    const briefer = new MemoryBriefer({
      summarize: deps.summarizer(config.model ?? event.model, {
        runId: context.runId,
        agentId: context.agentId,
        threadId: place.threadId,
        signal,
      }),
      ...(config.maxCards !== undefined && { maxCards: config.maxCards }),
      ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
      ...(config.prompt !== undefined && { prompt: config.prompt }),
    });
    const cards = await briefer.brief(input, sources);
    signal.throwIfAborted();
    const block = briefBlock(cards);
    if (block === undefined) return undefined;
    const messages = [...event.messages];
    addToTurnContext(messages, block);
    return { messages };
  }
}

/** The conversation of the run's branch, and the ids of the entries the run saved itself */
async function turnsOf(
  memory: MemoryAdapter,
  place: BriefPlace
): Promise<{ history: MemoryEntry[]; own: Set<string> }> {
  if (place.leafId === null) return { history: [], own: new Set() };
  const read = memory.getPath
    ? await memory.getPath({
        threadId: place.threadId,
        types: 'all',
        ...(place.leafId !== undefined && { leafId: place.leafId }),
      })
    : await memory.getEntries({ threadId: place.threadId, types: 'all' });
  if (!read.success) throw new Error(`Reading thread ${place.threadId} failed: ${read.error}`);
  const all = read.data;
  const conversational = (entry: MemoryEntry) => CONVERSATION.has(entry.type ?? 'message');
  const history = all.filter(conversational);
  if (place.ownAfter === undefined) return { history, own: new Set() };
  const cut =
    place.ownAfter === null ? 0 : all.findIndex((entry) => entry.id === place.ownAfter) + 1;
  if (cut === 0 && place.ownAfter !== null) return { history, own: new Set() };
  return {
    history,
    own: new Set(
      all
        .slice(cut)
        .filter(conversational)
        .map((entry) => entry.id)
    ),
  };
}
