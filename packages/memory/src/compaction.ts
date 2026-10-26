import {
  CONVERSATION_ENTRY_TYPES,
  type MemoryAdapter,
  type MemoryEntry,
  type MemoryEntryType,
  type MemoryResult,
  type CompactionConfig,
  type CompactionAtom,
  type CompactionEvent,
  type CompactionLevels,
  type CompactionNode,
  type CompactionResult,
  type CompactionStrategy,
  type Message,
} from '@cogitator-ai/types';
import { countEntryTokens, countMessagesTokens } from './token-counter';
import {
  CHAPTER_PROMPT,
  chapterTranscript,
  chapterWindows,
  CONTROL_KINDS,
  foldLevels,
  atomKey,
  lostControls,
  mergeAtoms,
  nodesOf,
  CHAPTER_CONTINUATIONS,
  chapterContinuationPrompt,
  openItemsPrompt,
  readChapter,
  renderHandoff,
  structuralAtoms,
} from './compaction-hierarchy';

/**
 * Summary settings taken from the `CompactionConfig` passed to `compact()`.
 */
export interface SummarizeOptions {
  /** `CompactionConfig.summaryModel`: the model that should write the summary. */
  model?: string;
  /** `CompactionConfig.summaryPrompt`: instructions for writing the summary. */
  prompt?: string;
  /** Tokens the answer may take, the backend's default when absent */
  maxTokens?: number;
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
    checkCompactionSettings(config);

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

    const keepsByCount =
      config.strategy !== 'hierarchical' || config.keepRecentTokens === undefined;
    if (
      !reachedThreshold(entries, config) ||
      (keepsByCount && entries.length <= config.keepRecent)
    ) {
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
   * Refuses a summary whose entries were deleted or redacted while it was written, such as by a
   * forget made meanwhile
   */
  private async sourcesStand(sessionId: string, compacted: readonly MemoryEntry[]): Promise<void> {
    for (const entry of compacted) {
      const read = await this.adapter.getEntry(entry.id);
      if (!read.success) throw new Error(`Failed to read the thread: ${read.error}`);
      const redactedSince = !entry.metadata?.redacted && read.data?.metadata?.redacted;
      if (read.data === null || redactedSince) {
        throw new Error(
          `Entries of ${sessionId} were deleted or redacted while it was compacted, compact it again`
        );
      }
    }
  }

  /**
   * Puts `summary` in place of `entriesToRemove`. On an adapter with branches it adds a
   * `compaction` entry to the active branch that leaves them out of the conversation from the
   * first of `entriesToKeep` on (see {@link compactedHistory}) and deletes nothing. On any other
   * adapter it adds the summary dated just before the first kept entry, with `levels` in its
   * metadata (`compactionLevels`), and deletes the summarized ones, re-adding the kept entries
   * after the summary when the adapter ignores `createdAt`.
   */
  async applySummary(
    sessionId: string,
    entriesToRemove: MemoryEntry[],
    summary: string,
    entriesToKeep: MemoryEntry[] = [],
    levels?: CompactionLevels
  ): Promise<number> {
    const summaryMessage: Message = {
      role: 'system',
      content: `[Conversation summary]\n${summary}`,
    };

    const summaryTokens = countMessagesTokens([summaryMessage]);
    await this.sourcesStand(sessionId, entriesToRemove);
    if (this.adapter.getPath) {
      await this.addCompaction(sessionId, summaryMessage, summaryTokens, {
        firstKeptEntryId: entriesToKeep[0]?.id ?? null,
        ...lastOf(entriesToRemove),
        compacted: entriesToRemove.length,
        summarized: true,
        ...(levels && { levels }),
      });
      return summaryTokens;
    }
    const placeAt = summaryTimestamp(entriesToRemove, entriesToKeep);

    const added = await this.adapter.addEntry({
      threadId: sessionId,
      message: summaryMessage,
      tokenCount: summaryTokens,
      metadata: {
        compactionSummary: true,
        compactedAt: new Date().toISOString(),
        ...(levels && { compactionLevels: levels }),
      },
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

  /**
   * The atoms of a chapter: what the summarizer finds in `window` (asked with
   * {@link CHAPTER_PROMPT} and the `open` control atoms of earlier chapters, which it may close,
   * asked again up to twice for an answer that holds no array of atoms, and asked to go on after
   * the last atom, up to {@link CHAPTER_CONTINUATIONS} times, when its length limit cut the
   * answer inside the array), with the control atoms the
   * entries of `own` (the window less the overlap it opens with) hold in their structure, which
   * no answer can lose. Those come first, so an item the summarizer closes with evidence that
   * holds stays closed. An open item only the overlap shows belongs to the chapter before and is
   * left out, so it does not come back once that chapter closed it.
   */
  async chapterAtoms(
    window: MemoryEntry[],
    config: CompactionConfig,
    options: { own?: MemoryEntry[]; open?: readonly CompactionAtom[] } = {}
  ): Promise<CompactionAtom[]> {
    const open = options.open ?? [];
    const prompt = [CHAPTER_PROMPT, openItemsPrompt(open), config.summaryPrompt]
      .filter(Boolean)
      .join('\n\n');
    const transcript = chapterTranscript(window, config.chapterTokens ?? DEFAULT_CHAPTER_TOKENS);
    const atoms: CompactionAtom[] = [];
    const seen = new Set<string>();
    let messages: Message[] = [{ role: 'user', content: transcript }];
    for (let continuation = 0; continuation <= CHAPTER_CONTINUATIONS; continuation++) {
      const answer = await this.chapterAnswer(messages, config, prompt, window);
      if (!answer) {
        if (continuation === 0) {
          throw new Error(
            'The summarizer did not answer with the atoms of a chapter after 3 tries'
          );
        }
        break;
      }
      const fresh = answer.read.atoms.filter((atom) => !seen.has(listedKey(atom)));
      for (const atom of fresh) seen.add(listedKey(atom));
      atoms.push(...fresh);
      const last = answer.read.atoms.at(-1);
      if (!answer.read.cut || !last || fresh.length === 0) break;
      messages = [
        { role: 'user', content: transcript },
        { role: 'assistant', content: answer.text },
        { role: 'user', content: chapterContinuationPrompt(atoms.length, last.text) },
      ];
    }
    const own = new Set((options.own ?? window).map((entry) => entry.id));
    const restated = ({ status, evidence = [] }: CompactionAtom) =>
      status === 'open' &&
      evidence.length > 0 &&
      evidence.every((piece) => piece.entryId === undefined || !own.has(piece.entryId));
    return mergeAtoms([
      {
        from: '',
        to: '',
        atoms: structuralAtoms(options.own ?? window, { context: window, open }),
      },
      { from: '', to: '', atoms: atoms.filter((atom) => !restated(atom)) },
    ]);
  }

  /** The summarizer's answer to `messages` that holds an array of atoms, of three tries at most */
  private async chapterAnswer(
    messages: Message[],
    config: CompactionConfig,
    prompt: string,
    window: readonly MemoryEntry[]
  ): Promise<{ text: string; read: { atoms: CompactionAtom[]; cut: boolean } } | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = await this.summarize(messages, {
        model: config.summaryModel,
        prompt,
        maxTokens: CHAPTER_MAX_TOKENS,
      });
      const read = readChapter(text, window);
      if (read) return { text, read };
    }
    return undefined;
  }

  getSummarizeFn(): SummarizeFn {
    return this.summarize;
  }

  getAdapter(): MemoryAdapter {
    return this.adapter;
  }
}

/**
 * An atom as the summarizer wrote it, its kind, words, status and quotes, so a continuation that
 * repeats an atom exactly adds nothing, while one that reopens or closes it from a later message
 * is kept after it, where the later status wins
 */
function listedKey(atom: CompactionAtom): string {
  return JSON.stringify([
    atomKey(atom),
    atom.status,
    (atom.evidence ?? []).map((piece) => [piece.entryId, piece.quote]),
  ]);
}

function lastOf(entries: readonly MemoryEntry[]): { lastCompactedEntryId?: string } {
  const last = entries.at(-1);
  return last ? { lastCompactedEntryId: last.id } : {};
}

function timeOf(value: Date | string): number {
  return new Date(value).getTime();
}

/** Whether the thread holds enough tokens or entries to be compacted. */
/**
 * Throws for `hierarchical` settings that are not whole numbers above 0 (`keepRecentTokens` may
 * be 0), which would fold every chapter at once or never stop folding
 */
export function checkCompactionSettings(config: Partial<CompactionConfig>): void {
  for (const key of [
    'chapterTokens',
    'chapterConcurrency',
    'chaptersPerArc',
    'arcsPerSaga',
  ] as const) {
    const value = config[key];
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
      throw new Error(`compaction.${key} must be a whole number above 0, got ${value}`);
    }
  }
  const tail = config.keepRecentTokens;
  if (tail !== undefined && !(Number.isInteger(tail) && tail >= 0)) {
    throw new Error(`compaction.keepRecentTokens must be a whole number of 0 or more, got ${tail}`);
  }
}

/**
 * Whether `entry` was written after `summary`, not kept by it: by its place on the branch when
 * the adapter numbers entries, else by when it was written
 */
function writtenAfter(entry: MemoryEntry, summary: MemoryEntry): boolean {
  if (entry.seq !== undefined && summary.seq !== undefined) return entry.seq > summary.seq;
  return entry.createdAt.getTime() > summary.createdAt.getTime();
}

/**
 * The entries of `conversation` (a compacted one, its summary first) written since its summary,
 * which leaves out the tail the summary kept: all of them when it opens with no summary
 */
export function sinceSummary(conversation: readonly MemoryEntry[]): MemoryEntry[] {
  const [summary, ...rest] = conversation;
  if (
    !summary ||
    !(summary.type === 'compaction' || summary.metadata?.compactionSummary === true)
  ) {
    return [...conversation];
  }
  return rest.filter((entry) => writtenAfter(entry, summary));
}

/**
 * Whether `entries` reached the threshold: `threshold` counts the tokens of the whole
 * conversation, `messageThreshold` its entries, for `hierarchical` only those written since the
 * last summary, since the tail it keeps by tokens can hold more entries than the threshold
 */
function reachedThreshold(entries: MemoryEntry[], config: CompactionConfig): boolean {
  const counted = config.strategy === 'hierarchical' ? sinceSummary(entries) : entries;
  if (config.messageThreshold !== undefined && counted.length >= config.messageThreshold) {
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

/**
 * Where the kept tail of `conversation` starts: the newest `keepRecentTokens` tokens of whole
 * turns when set, a turn opening with a user message, else the newest `keepRecent` entries moved
 * back to the call a kept tool result answers
 */
function tailStart(conversation: readonly MemoryEntry[], config: CompactionConfig): number {
  if (config.keepRecentTokens !== undefined) {
    let used = 0;
    let start = conversation.length;
    for (let at = conversation.length - 1; at >= 0; at--) {
      used += countEntryTokens(conversation[at]!);
      if (used > config.keepRecentTokens) break;
      if (conversation[at]!.message.role === 'user') start = at;
    }
    if (start === conversation.length) {
      const lastInput = conversation.map((entry) => entry.message.role).lastIndexOf('user');
      return lastInput === -1 ? conversation.length : lastInput;
    }
    return start;
  }
  let start = Math.max(0, conversation.length - config.keepRecent);
  while (start > 0 && conversation[start]?.message.role === 'tool') start--;
  return start;
}

const DEFAULT_CHAPTER_TOKENS = 4000;
/**
 * Tokens a chapter answer may take, asked for explicitly so a dense chapter fits whatever the
 * backend's default is, and continuing a cut answer stays the exception
 */
const CHAPTER_MAX_TOKENS = 8000;
const DEFAULT_CHAPTERS_PER_ARC = 4;
const DEFAULT_ARCS_PER_SAGA = 4;
/** Open items of earlier chapters a chapter prompt lists, the newest */
const OPEN_ITEMS = 40;

/** The open control atoms of `nodes`, the newest {@link OPEN_ITEMS} */
function openItems(nodes: readonly CompactionNode[]): CompactionAtom[] {
  return mergeAtoms(nodes)
    .filter((atom) => CONTROL_KINDS.has(atom.kind) && atom.status === 'open')
    .slice(-OPEN_ITEMS);
}

function tokensOf(entries: readonly MemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + countEntryTokens(entry), 0);
}

/**
 * Keeps a tree of grounded atoms in place of the conversation before the kept tail: the entries
 * new since the last compaction become chapters (windows read by the summarizer, one at a time or
 * `chapterConcurrency` at once, each told the items still open before it), chapters beyond
 * `chaptersPerArc` fold into arcs and arcs beyond `arcsPerSaga` into the saga, with no model. A
 * part to compact under a tenth of the kept tail is left for later, since it would change the
 * summary, and so the cached prompt, for little. The summary is published only when every open
 * control atom of the one before it is still there or was closed, and its message is the handoff
 * rendered from the tree.
 */
const hierarchicalStrategy: StrategyFn = async (service, sessionId, entries, config) => {
  const summaries = entries.filter(
    (entry) => entry.type === 'compaction' || entry.metadata?.compactionSummary === true
  );
  const before = summaries.at(-1);
  const stored =
    (before?.event as Partial<CompactionEvent> | undefined)?.levels ??
    (before?.metadata?.compactionLevels as CompactionLevels | undefined);
  const conversation = entries.filter((entry) => !summaries.includes(entry));
  const tail = tailStart(conversation, config);
  const compacted = conversation.slice(0, tail);
  const unchanged: CompactionResult = {
    sessionId,
    originalMessages: entries.length,
    compactedMessages: entries.length,
    summaryTokens: 0,
  };
  if (compacted.length === 0) return unchanged;
  if (tokensOf(compacted) * 10 < tokensOf(conversation.slice(tail))) return unchanged;

  const previous: CompactionLevels = stored ?? {
    arcs: [],
    chapters: before
      ? [
          {
            from: before.id,
            to: before.id,
            atoms: [
              {
                kind: 'fact',
                status: 'closed',
                text: String(before.message.content),
                verified: false,
              },
            ],
          },
        ]
      : [],
  };
  const windows = chapterWindows(compacted, config.chapterTokens ?? DEFAULT_CHAPTER_TOKENS);
  const chapters: CompactionNode[] = [];
  const concurrency = config.chapterConcurrency ?? 1;
  for (let at = 0; at < windows.length; at += concurrency) {
    let known: CompactionNode[] = [...nodesOf(previous), ...chapters];
    const batch = windows.slice(at, at + concurrency).map(({ window, own }) => {
      const open = openItems(known);
      known = [
        ...known,
        { from: '', to: '', atoms: structuralAtoms(own, { context: window, open }) },
      ];
      return { window, own, open };
    });
    chapters.push(
      ...(await Promise.all(
        batch.map(async ({ window, own, open }) => ({
          from: own[0]!.id,
          to: own.at(-1)!.id,
          atoms: await service.chapterAtoms(window, config, { own, open }),
        }))
      ))
    );
  }
  const levels = foldLevels(
    { ...previous, chapters: [...previous.chapters, ...chapters] },
    config.chaptersPerArc ?? DEFAULT_CHAPTERS_PER_ARC,
    config.arcsPerSaga ?? DEFAULT_ARCS_PER_SAGA
  );
  const settled = new Map(
    mergeAtoms([...nodesOf(previous), ...chapters]).map((atom) => [atomKey(atom), atom])
  );
  const lost = lostControls(previous, levels).filter(
    (atom) => settled.get(atomKey(atom))?.status !== 'closed'
  );
  if (lost.length > 0) {
    throw new Error(
      `The summary would lose ${lost.length} open item(s), such as "${lost[0]!.text}": it is not published`
    );
  }
  const summaryTokens = await service.applySummary(
    sessionId,
    [...summaries, ...compacted],
    renderHandoff(levels),
    conversation.slice(tail),
    levels
  );
  return {
    sessionId,
    originalMessages: entries.length,
    compactedMessages: conversation.length - tail + 1,
    summaryTokens,
  };
};

const strategies: Record<CompactionStrategy, StrategyFn> = {
  hierarchical: hierarchicalStrategy,
  summary: summaryStrategy,
  'sliding-window': slidingWindowStrategy,
  hybrid: hybridStrategy,
};

/** The event kind of the entry that marks a new lease epoch of a durable run in its thread */
export const DURABLE_FENCE = 'durable_fence';

/**
 * `entries` (in the order they were written) without the entries a durable run wrote late: an
 * entry that names a lease epoch (`metadata.durableEpoch`) older than one its run reached before
 * it in the list, by a fence (`DURABLE_FENCE`) or an entry of a newer epoch. A process that lost
 * its run to another can have a write land after the takeover, memory adapters cannot refuse it,
 * so readers leave it out. Entries of other runs and entries without an epoch pass as they are
 */
export function withoutStaleDurableEntries<T extends MemoryEntry>(entries: readonly T[]): T[] {
  const newest = new Map<string, number>();
  return entries.filter((entry) => {
    const tag = entry.metadata?.durableRun;
    const epoch = entry.metadata?.durableEpoch;
    if (typeof tag !== 'string' || typeof epoch !== 'number') return true;
    const runId = tag.slice(0, tag.lastIndexOf('/'));
    if (epoch < (newest.get(runId) ?? 0)) return false;
    newest.set(runId, epoch);
    return true;
  });
}
