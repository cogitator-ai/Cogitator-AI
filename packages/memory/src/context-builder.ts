/**
 * Context builder with token management
 *
 * Builds conversation context from memory while respecting token limits.
 */

import type {
  Message,
  MemoryEntry,
  Fact,
  Embedding,
  GraphContext,
  ContextBuilderConfig,
  ContextBuildError,
  BuiltContext,
  DroppedContext,
  GraphNode,
  MemoryAdapter,
  FactAdapter,
  EmbeddingAdapter,
  EmbeddingService,
  MemoryResult,
} from '@cogitator-ai/types';
import type { GraphContextBuilder } from './knowledge-graph/graph-context-builder';
import { countEntryTokens, countMessageTokens, countTokens } from './token-counter';
import { indexedText, type IndexedText, type MessageIndex } from './message-index';

const SEMANTIC_RESULTS = 5;

/**
 * How many of the newest history entries the `relevant` and `hybrid` strategies score against
 * the input. Older entries are left out, which keeps the cost of a turn flat on long threads.
 */
const MAX_SCORED_ENTRIES = 200;

/** History entry vectors kept per builder, so an entry is embedded once rather than every turn. */
const ENTRY_VECTOR_CACHE_SIZE = 4096;

/** Entries older than the scored window a `messageIndex` search may bring back */
const INDEX_SEARCH_RESULTS = 50;

/** What semantic context searches: facts and documents, never the vectors of messages */
const SEMANTIC_SOURCES: Embedding['sourceType'][] = ['fact', 'document'];

/** The value of a memory operation, or an error naming the operation that failed. */
function unwrap<T>(result: MemoryResult<T>, operation: string): T {
  if (!result.success) throw new Error(`Memory ${operation} failed: ${result.error}`);
  return result.data;
}

/**
 * Whether memory scoped by `metadata` may go into a context: never when it
 * belongs to another agent (`metadata.agentId`) or another user
 * (`metadata.userId`); memory without an owner (shared documents, agent-wide
 * facts) is visible to everyone.
 */
function isVisibleTo(
  metadata: Record<string, unknown> | undefined,
  agentId: string,
  userId: string | undefined
): boolean {
  const agent = metadata?.agentId;
  const user = metadata?.userId;
  return (
    (agent === undefined || agent === null || agent === agentId) &&
    (user === undefined || user === null || user === userId)
  );
}

export interface ContextBuilderDeps {
  memoryAdapter: MemoryAdapter;
  factAdapter?: FactAdapter;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingService?: EmbeddingService;
  graphContextBuilder?: GraphContextBuilder;
  /**
   * Vectors of history entries kept in an embedding store. With it `relevant` and `hybrid`
   * embed only the input and the entries not indexed yet, and find older entries of the thread
   * by a search of the store. Without it the builder keeps vectors in process.
   */
  messageIndex?: MessageIndex;
}

export interface BuildContextOptions {
  threadId: string;
  agentId: string;
  /** The user the context is built for: facts and embeddings of other users are left out */
  userId?: string;
  systemPrompt?: string;
  currentInput?: string;
  /**
   * Token budget of this context in place of the builder's `maxTokens`, such as the context
   * window of the model it is built for
   */
  maxTokens?: number;
  /**
   * The entry the history ends at: the thread's active branch by default, the branch ending at
   * this entry when given, none for null. Needs an adapter with branches; without, the whole
   * thread is read.
   */
  leafId?: string | null;
}

type ResolvedConfig = Required<Omit<ContextBuilderConfig, 'maxTokens' | 'reserveTokens'>> &
  Pick<ContextBuilderConfig, 'maxTokens' | 'reserveTokens'>;

/** What scoring knows of the build: the index mark taken before the read, and the thread size */
interface ScoringScope {
  mark?: number;
  threadSize: number;
}

/** Part of a context: what fits its budget, and what does not. */
interface Fitted<T> {
  kept: T[];
  dropped: T[];
}

function validBudget(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ContextBuilder ${name} must be a positive number, got ${value}`);
  }
  return value;
}

export class ContextBuilder {
  private config: ResolvedConfig;
  private deps: ContextBuilderDeps;
  private readonly entryVectors = new Map<string, Float32Array>();

  constructor(config: ContextBuilderConfig, deps: ContextBuilderDeps) {
    if (config.maxTokens !== undefined) validBudget(config.maxTokens, 'maxTokens');
    this.config = {
      maxTokens: config.maxTokens,
      reserveTokens: config.reserveTokens,
      strategy: config.strategy,
      includeSystemPrompt: config.includeSystemPrompt ?? true,
      includeFacts: config.includeFacts ?? false,
      includeSemanticContext: config.includeSemanticContext ?? false,
      includeGraphContext: config.includeGraphContext ?? false,
      graphContextOptions: config.graphContextOptions ?? {},
    };
    this.deps = deps;
  }

  /**
   * The context for a turn of `options.threadId`, within `options.maxTokens`, else the builder's
   * `maxTokens`, minus `reserveTokens`. What does not fit is listed in `dropped`.
   *
   * @throws Error when neither `options.maxTokens` nor the builder's `maxTokens` is set
   */
  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const configured = options.maxTokens ?? this.config.maxTokens;
    if (configured === undefined) {
      throw new Error(
        'ContextBuilder has no token budget: set maxTokens in its config or pass it to build()'
      );
    }
    const maxTokens = validBudget(configured, 'maxTokens');
    const reserveTokens = this.config.reserveTokens ?? Math.max(100, Math.floor(maxTokens * 0.1));
    const availableTokens = Math.max(0, maxTokens - reserveTokens);
    const errors: ContextBuildError[] = [];
    const warnings: string[] = [];
    const systemBlocks: string[] = [];
    let usedTokens = 0;
    const remaining = () => Math.max(0, availableTokens - usedTokens);
    const partBudget = (share: number) =>
      Math.min(Math.floor(availableTokens * share), remaining());

    if (this.config.includeSystemPrompt && options.systemPrompt) {
      const tokens = countMessageTokens({ role: 'system', content: options.systemPrompt });
      systemBlocks.push(options.systemPrompt);
      usedTokens += tokens;
      if (tokens > availableTokens) {
        warnings.push(
          `The system prompt takes ${tokens} tokens, more than the ${availableTokens} the context ` +
            `budget allows (maxTokens ${maxTokens} minus reserveTokens ` +
            `${reserveTokens}); it is kept, but no history fits. Raise maxTokens.`
        );
      }
    }

    const fittedFacts = this.config.includeFacts
      ? await this.attempt('facts', errors, () => this.loadFacts(options, partBudget(0.1)))
      : undefined;
    const facts = fittedFacts?.kept ?? [];
    if (facts.length > 0) {
      const block = `Known facts:\n${facts.map((f) => `- ${f.content}`).join('\n')}`;
      systemBlocks.push(block);
      usedTokens += countTokens(block);
    }

    const fittedSemantic =
      this.config.includeSemanticContext && options.currentInput
        ? await this.attempt('semantic', errors, () =>
            this.loadSemanticResults(options, partBudget(0.1))
          )
        : undefined;
    const semanticResults = fittedSemantic?.kept ?? [];
    if (semanticResults.length > 0) {
      systemBlocks.push(
        `Relevant context:\n${semanticResults.map((r) => `- ${r.content}`).join('\n')}`
      );
      usedTokens += semanticResults.reduce((sum, r) => sum + countTokens(r.content), 0);
    }

    const fittedGraph =
      this.config.includeGraphContext && options.currentInput
        ? await this.attempt('graph', errors, () =>
            this.loadGraphContext(options, partBudget(0.15))
          )
        : undefined;
    const graphContext = fittedGraph?.context;
    if (graphContext?.formattedContext) {
      systemBlocks.push(graphContext.formattedContext);
      usedTokens += graphContext.tokenCount;
    }

    const messages: Message[] =
      systemBlocks.length > 0 ? [{ role: 'system', content: systemBlocks.join('\n\n') }] : [];
    const injectedSystemMessages = messages.length;

    const scope: ScoringScope = { mark: this.deps.messageIndex?.mark(), threadSize: 0 };
    const entries = (await this.attempt('history', errors, () => this.readHistory(options))) ?? [];

    scope.threadSize = entries.length;
    const selectedEntries = await this.selectEntries(
      entries,
      remaining(),
      options.currentInput,
      errors,
      scope
    );
    for (const entry of selectedEntries) {
      messages.push(entry.message);
      usedTokens += countEntryTokens(entry);
    }
    const selected = new Set(selectedEntries);
    const dropped: DroppedContext = {
      entries: entries.filter((entry) => !selected.has(entry)),
      facts: fittedFacts?.dropped ?? [],
      semanticResults: fittedSemantic?.dropped ?? [],
      graphNodes: fittedGraph?.droppedNodes ?? [],
      tokenCount: 0,
    };
    dropped.tokenCount =
      dropped.entries.reduce((sum, entry) => sum + countEntryTokens(entry), 0) +
      dropped.facts.reduce((sum, fact) => sum + countTokens(`- ${fact.content}`), 0) +
      dropped.semanticResults.reduce((sum, result) => sum + countTokens(result.content), 0) +
      (fittedGraph?.droppedTokens ?? 0);

    return {
      messages,
      facts,
      semanticResults,
      graphContext,
      tokenCount: usedTokens,
      truncated: dropped.entries.length > 0,
      dropped,
      ...(errors.length > 0 && { errors }),
      ...(warnings.length > 0 && { warnings }),
      metadata: {
        originalMessageCount: entries.length,
        includedMessageCount: messages.length - injectedSystemMessages,
        factsIncluded: facts.length,
        semanticResultsIncluded: semanticResults.length,
        graphNodesIncluded: graphContext?.nodes.length ?? 0,
        graphEdgesIncluded: graphContext?.edges.length ?? 0,
      },
    };
  }

  /** Runs `work`, recording a failure as an error of `source` instead of failing the build. */
  private async attempt<T>(
    source: ContextBuildError['source'],
    errors: ContextBuildError[],
    work: () => Promise<T>
  ): Promise<T | undefined> {
    try {
      return await work();
    } catch (err) {
      errors.push({ source, error: err instanceof Error ? err : new Error(String(err)) });
      return undefined;
    }
  }

  /** Facts of the agent visible to the user, as many as fit `budget`, and the rest. */
  private async loadFacts(options: BuildContextOptions, budget: number): Promise<Fitted<Fact>> {
    if (!this.deps.factAdapter) return { kept: [], dropped: [] };
    const all = unwrap(await this.deps.factAdapter.getFacts(options.agentId), 'getFacts');
    const fitted: Fitted<Fact> = { kept: [], dropped: [] };
    let tokens = 0;
    for (const fact of all) {
      if (!isVisibleTo(fact.metadata, options.agentId, options.userId)) continue;
      const factTokens = countTokens(`- ${fact.content}`);
      if (tokens + factTokens <= budget) {
        fitted.kept.push(fact);
        tokens += factTokens;
      } else {
        fitted.dropped.push(fact);
      }
    }
    return fitted;
  }

  /**
   * The embeddings closest to the current input visible to the user, as many as fit `budget`,
   * and the rest.
   */
  private async loadSemanticResults(
    options: BuildContextOptions,
    budget: number
  ): Promise<Fitted<Embedding & { score: number }>> {
    const { embeddingAdapter, embeddingService } = this.deps;
    if (!embeddingAdapter || !embeddingService || !options.currentInput) {
      return { kept: [], dropped: [] };
    }

    const vector = await embeddingService.embed(options.currentInput);
    const found = unwrap(
      await embeddingAdapter.search({
        vector,
        limit: SEMANTIC_RESULTS * 4,
        threshold: 0.7,
        filter: {
          sourceTypes: SEMANTIC_SOURCES,
          ...(options.userId !== undefined && { userId: options.userId }),
        },
      }),
      'search'
    );

    const fitted: Fitted<Embedding & { score: number }> = { kept: [], dropped: [] };
    let tokens = 0;
    for (const result of found
      .filter(
        (r) =>
          SEMANTIC_SOURCES.includes(r.sourceType) &&
          isVisibleTo(r.metadata, options.agentId, options.userId)
      )
      .slice(0, SEMANTIC_RESULTS)) {
      const resultTokens = countTokens(result.content);
      if (tokens + resultTokens <= budget) {
        fitted.kept.push(result);
        tokens += resultTokens;
      } else {
        fitted.dropped.push(result);
      }
    }
    return fitted;
  }

  /**
   * Knowledge graph context for the current input, cut down to `budget` when it is larger, with
   * the nodes and tokens the cut left out.
   */
  private async loadGraphContext(
    options: BuildContextOptions,
    budget: number
  ): Promise<{ context?: GraphContext; droppedNodes: GraphNode[]; droppedTokens: number }> {
    const none = { droppedNodes: [], droppedTokens: 0 };
    const graph = this.deps.graphContextBuilder;
    if (!graph || !options.currentInput) return none;

    const graphOptions = { ...this.config.graphContextOptions, userId: options.userId };
    const gc = await graph.buildContext(options.agentId, options.currentInput, graphOptions);
    if (gc.nodes.length === 0) return none;
    if (gc.tokenCount <= budget) return { context: gc, ...none };

    const ratio = budget / gc.tokenCount;
    const limitedNodes = gc.nodes.slice(0, Math.max(1, Math.floor(gc.nodes.length * ratio)));
    const limitedNodeIds = new Set(limitedNodes.map((n) => n.id));
    const limitedEdges = gc.edges.filter(
      (e) => limitedNodeIds.has(e.sourceNodeId) && limitedNodeIds.has(e.targetNodeId)
    );
    const rebuilt = await graph.buildContext(options.agentId, options.currentInput, {
      ...graphOptions,
      maxNodes: limitedNodes.length,
      maxEdges: limitedEdges.length,
    });
    const context = rebuilt.tokenCount <= budget ? rebuilt : undefined;
    const keptIds = new Set(context?.nodes.map((n) => n.id));
    return {
      ...(context && { context }),
      droppedNodes: gc.nodes.filter((n) => !keptIds.has(n.id)),
      droppedTokens: gc.tokenCount - (context?.tokenCount ?? 0),
    };
  }

  /**
   * The history a context draws on: the active branch (or the one `leafId` names) of an adapter
   * with branches, else every entry of the thread
   */
  private async readHistory(options: BuildContextOptions): Promise<MemoryEntry[]> {
    const memory = this.deps.memoryAdapter;
    if (options.leafId === null) return [];
    if (memory.getPath) {
      return unwrap(
        await memory.getPath({
          threadId: options.threadId,
          ...(options.leafId !== undefined && { leafId: options.leafId }),
          includeToolCalls: true,
        }),
        'getPath'
      );
    }
    return unwrap(
      await memory.getEntries({ threadId: options.threadId, includeToolCalls: true }),
      'getEntries'
    );
  }

  private selectEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput: string | undefined,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<MemoryEntry[]> | MemoryEntry[] {
    switch (this.config.strategy) {
      case 'relevant':
        return this.selectRelevantEntries(entries, availableTokens, currentInput, errors, scope);
      case 'hybrid':
        return this.selectHybridEntries(entries, availableTokens, currentInput, errors, scope);
      case 'recent':
      default:
        return this.selectRecentEntries(entries, availableTokens);
    }
  }

  /**
   * The longest run of newest entries that fits the budget. The window stops at the first entry
   * that does not fit instead of skipping it, so the model never sees a reply without the message
   * it answers.
   */
  private selectRecentEntries(entries: MemoryEntry[], availableTokens: number): MemoryEntry[] {
    let start = entries.length;
    let usedTokens = 0;

    while (start > 0 && usedTokens + countEntryTokens(entries[start - 1]) <= availableTokens) {
      start--;
      usedTokens += countEntryTokens(entries[start]);
    }

    return entries.slice(start);
  }

  /**
   * Entries most similar to the current input that fit the budget, in conversation order.
   * Falls back to the most recent entries when there is no input or embedding service, or when
   * scoring fails.
   */
  private async selectRelevantEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput: string | undefined,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<MemoryEntry[]> {
    if (!currentInput || !this.deps.embeddingService) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const scored = await this.scoreEntries(entries, currentInput, 0, errors, scope);
    if (scored === null) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const selectedIds = new Set<string>();
    let usedTokens = 0;
    for (const { entry } of scored) {
      const tokens = countEntryTokens(entry);
      if (usedTokens + tokens <= availableTokens) {
        selectedIds.add(entry.id);
        usedTokens += tokens;
      }
    }

    return entries.filter((e) => selectedIds.has(e.id));
  }

  /**
   * Similarity of user/assistant text entries to the input, best first. The newest
   * {@link MAX_SCORED_ENTRIES} are scored against their vectors, each embedded once: kept in the
   * `messageIndex` when there is one, else by entry id in process. With a `messageIndex`, older
   * entries the store finds close to the input are scored too. When the index fails, the newest
   * entries are scored with vectors kept in process and the failure is recorded as a `relevance`
   * error. Returns null, recording one, when embedding fails.
   */
  private async scoreEntries(
    entries: MemoryEntry[],
    input: string,
    minScore: number,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<{ entry: MemoryEntry; score: number }[] | null> {
    const embeddingService = this.deps.embeddingService;
    if (!embeddingService) return null;

    const embeddable: { entry: MemoryEntry; text: IndexedText }[] = [];
    for (const entry of entries) {
      const text = indexedText(entry);
      if (text) embeddable.push({ entry, text });
    }
    const candidates = embeddable.slice(-MAX_SCORED_ENTRIES);
    if (candidates.length === 0) return [];
    const older = embeddable.slice(0, embeddable.length - candidates.length);
    const index = this.deps.messageIndex;
    const threadId = candidates[0]!.entry.threadId;
    if (index && older.length > 0) {
      index.backfill(
        threadId,
        older.map(({ text }) => text),
        scope.mark
      );
    }

    try {
      const texts = candidates.map(({ text }) => text);
      const windowVectors = async (): Promise<{
        vectors: Map<string, Float32Array>;
        indexed: boolean;
      }> => {
        if (!index) return { vectors: await this.processVectors(texts), indexed: false };
        try {
          return { vectors: await index.vectorsOf(texts, scope.mark), indexed: true };
        } catch (err) {
          errors.push({
            source: 'relevance',
            error: err instanceof Error ? err : new Error(String(err)),
          });
          return { vectors: await this.processVectors(texts), indexed: false };
        }
      };
      const [inputVector, { vectors, indexed }] = await Promise.all([
        embeddingService.embed(input),
        windowVectors(),
      ]);
      index?.offer(input, inputVector);

      const scored: { entry: MemoryEntry; score: number }[] = [];
      for (const { entry } of candidates) {
        const vector = vectors.get(entry.id);
        if (!vector) continue;
        const score = this.cosineSimilarity(inputVector, vector);
        if (score > minScore) scored.push({ entry, score });
      }

      if (index && indexed && older.length > 0) {
        try {
          const found = await index.search(
            threadId,
            inputVector,
            INDEX_SEARCH_RESULTS + Math.max(0, scope.threadSize - older.length),
            minScore
          );
          for (const { entry } of older) {
            const score = found.get(entry.id);
            if (score !== undefined && score > minScore) scored.push({ entry, score });
          }
        } catch (err) {
          errors.push({
            source: 'relevance',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
      return scored.sort((a, b) => b.score - a.score);
    } catch (err) {
      errors.push({
        source: 'relevance',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    }
  }

  /** Vectors of `texts` by entry id from the builder's own cache, embedding the ones it lacks */
  private async processVectors(texts: IndexedText[]): Promise<Map<string, Float32Array>> {
    const embeddingService = this.deps.embeddingService;
    const missing = texts.filter(({ entryId }) => !this.entryVectors.has(entryId));
    if (embeddingService && missing.length > 0) {
      const vectors = await embeddingService.embedBatch(missing.map(({ text }) => text));
      if (vectors.length !== missing.length) {
        throw new Error(
          `Embedding returned ${vectors.length} vectors for ${missing.length} history entries`
        );
      }
      missing.forEach(({ entryId }, i) => this.rememberVector(entryId, vectors[i]));
    }
    const found = new Map<string, Float32Array>();
    for (const { entryId } of texts) {
      const vector = this.recallVector(entryId);
      if (vector) found.set(entryId, vector);
    }
    return found;
  }

  private rememberVector(entryId: string, vector: number[]): void {
    this.entryVectors.delete(entryId);
    this.entryVectors.set(entryId, Float32Array.from(vector));
    if (this.entryVectors.size > ENTRY_VECTOR_CACHE_SIZE) {
      const oldest = this.entryVectors.keys().next().value;
      if (oldest !== undefined) this.entryVectors.delete(oldest);
    }
  }

  private recallVector(entryId: string): Float32Array | undefined {
    const vector = this.entryVectors.get(entryId);
    if (vector) {
      this.entryVectors.delete(entryId);
      this.entryVectors.set(entryId, vector);
    }
    return vector;
  }

  private async selectHybridEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput: string | undefined,
    errors: ContextBuildError[],
    scope: ScoringScope
  ): Promise<MemoryEntry[]> {
    if (!currentInput || !this.deps.embeddingService || entries.length <= 10) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const semanticBudget = Math.floor(availableTokens * 0.3);
    const usedIds = new Set<string>();
    let usedTokens = 0;

    const olderEntries = entries
      .slice(0, -10)
      .filter((e) => typeof e.message.content !== 'string' || e.message.content.length > 20);
    const scoredEntries =
      (await this.scoreEntries(olderEntries, currentInput, 0.6, errors, scope)) ?? [];

    for (const { entry } of scoredEntries) {
      const tokens = countEntryTokens(entry);
      if (usedTokens + tokens <= semanticBudget) {
        usedIds.add(entry.id);
        usedTokens += tokens;
      }
    }

    const recentEntries = this.selectRecentEntries(
      entries.filter((e) => !usedIds.has(e.id)),
      availableTokens - usedTokens
    );
    for (const entry of recentEntries) usedIds.add(entry.id);

    return entries.filter((e) => usedIds.has(e.id));
  }

  private cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }
}
