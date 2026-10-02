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
  BuiltContext,
  MemoryAdapter,
  FactAdapter,
  EmbeddingAdapter,
  EmbeddingService,
} from '@cogitator-ai/types';
import type { GraphContextBuilder } from './knowledge-graph/graph-context-builder';
import { countMessageTokens, countTokens } from './token-counter';

const SEMANTIC_RESULTS = 5;

/**
 * Embeddings scoped to another agent (`metadata.agentId`) are never injected; unscoped
 * embeddings (shared documents) are visible to every agent.
 */
function isVisibleToAgent(embedding: Embedding, agentId: string): boolean {
  const owner = embedding.metadata?.agentId;
  return owner === undefined || owner === null || owner === agentId;
}

export interface ContextBuilderDeps {
  memoryAdapter: MemoryAdapter;
  factAdapter?: FactAdapter;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingService?: EmbeddingService;
  graphContextBuilder?: GraphContextBuilder;
}

export interface BuildContextOptions {
  threadId: string;
  agentId: string;
  systemPrompt?: string;
  currentInput?: string;
}

export class ContextBuilder {
  private config: Required<ContextBuilderConfig>;
  private deps: ContextBuilderDeps;

  constructor(config: ContextBuilderConfig, deps: ContextBuilderDeps) {
    const defaultReserve = Math.max(100, Math.floor(config.maxTokens * 0.1));
    this.config = {
      maxTokens: config.maxTokens,
      reserveTokens: config.reserveTokens ?? defaultReserve,
      strategy: config.strategy,
      includeSystemPrompt: config.includeSystemPrompt ?? true,
      includeFacts: config.includeFacts ?? false,
      includeSemanticContext: config.includeSemanticContext ?? false,
      includeGraphContext: config.includeGraphContext ?? false,
      graphContextOptions: config.graphContextOptions ?? {},
    };
    this.deps = deps;
  }

  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const availableTokens = this.config.maxTokens - this.config.reserveTokens;
    let usedTokens = 0;
    let injectedSystemMessages = 0;
    const messages: Message[] = [];
    const facts: Fact[] = [];
    const semanticResults: (Embedding & { score: number })[] = [];
    let graphContext: GraphContext | undefined;

    if (this.config.includeSystemPrompt && options.systemPrompt) {
      const systemMsg: Message = { role: 'system', content: options.systemPrompt };
      const tokens = countMessageTokens(systemMsg);
      if (usedTokens + tokens <= availableTokens) {
        messages.push(systemMsg);
        usedTokens += tokens;
        injectedSystemMessages++;
      }
    }

    if (this.config.includeFacts && this.deps.factAdapter) {
      const factsResult = await this.deps.factAdapter.getFacts(options.agentId);
      if (factsResult.success && factsResult.data.length > 0) {
        const factTokenBudget = Math.floor(availableTokens * 0.1);
        let factTokens = 0;

        for (const fact of factsResult.data) {
          const tokens = countTokens(`- ${fact.content}`);
          if (factTokens + tokens <= factTokenBudget) {
            facts.push(fact);
            factTokens += tokens;
          }
        }

        if (facts.length > 0) {
          const factsStr = facts.map((f) => `- ${f.content}`).join('\n');
          const formattedBlock = `Known facts:\n${factsStr}`;
          if (messages.length > 0 && messages[0].role === 'system') {
            messages[0] = {
              ...messages[0],
              content: `${messages[0].content}\n\n${formattedBlock}`,
            };
          } else {
            messages.unshift({
              role: 'system',
              content: formattedBlock,
            });
            injectedSystemMessages++;
          }
          usedTokens += countTokens(formattedBlock);
        }
      }
    }

    if (
      this.config.includeSemanticContext &&
      this.deps.embeddingAdapter &&
      this.deps.embeddingService &&
      options.currentInput
    ) {
      const vector = await this.deps.embeddingService.embed(options.currentInput);
      const rawResult = await this.deps.embeddingAdapter.search({
        vector,
        limit: SEMANTIC_RESULTS * 4,
        threshold: 0.7,
      });
      const searchResult = rawResult.success
        ? {
            ...rawResult,
            data: rawResult.data
              .filter((r) => isVisibleToAgent(r, options.agentId))
              .slice(0, SEMANTIC_RESULTS),
          }
        : rawResult;

      if (searchResult.success) {
        const semanticTokenBudget = Math.floor(availableTokens * 0.1);
        let semanticTokens = 0;

        for (const result of searchResult.data) {
          const tokens = countTokens(result.content);
          if (semanticTokens + tokens <= semanticTokenBudget) {
            semanticResults.push(result);
            semanticTokens += tokens;
          }
        }

        if (semanticResults.length > 0) {
          const contextStr = semanticResults.map((r) => `- ${r.content}`).join('\n');
          if (messages.length > 0 && messages[0].role === 'system') {
            messages[0] = {
              ...messages[0],
              content: `${messages[0].content}\n\nRelevant context:\n${contextStr}`,
            };
          } else {
            messages.unshift({
              role: 'system',
              content: `Relevant context:\n${contextStr}`,
            });
            injectedSystemMessages++;
          }
          usedTokens += semanticTokens;
        }
      }
    }

    if (this.config.includeGraphContext && this.deps.graphContextBuilder && options.currentInput) {
      const gc = await this.deps.graphContextBuilder.buildContext(
        options.agentId,
        options.currentInput,
        this.config.graphContextOptions
      );

      if (gc.nodes.length > 0) {
        const graphTokenBudget = Math.floor(availableTokens * 0.15);
        if (gc.tokenCount <= graphTokenBudget) {
          graphContext = gc;
        } else {
          const ratio = graphTokenBudget / gc.tokenCount;
          const limitedNodes = gc.nodes.slice(0, Math.max(1, Math.floor(gc.nodes.length * ratio)));
          const limitedNodeIds = new Set(limitedNodes.map((n) => n.id));
          const limitedEdges = gc.edges.filter(
            (e) => limitedNodeIds.has(e.sourceNodeId) && limitedNodeIds.has(e.targetNodeId)
          );
          const rebuilt = await this.deps.graphContextBuilder.buildContext(
            options.agentId,
            options.currentInput,
            {
              ...this.config.graphContextOptions,
              maxNodes: limitedNodes.length,
              maxEdges: limitedEdges.length,
            }
          );
          if (rebuilt.tokenCount <= graphTokenBudget) {
            graphContext = rebuilt;
          }
        }

        if (graphContext?.formattedContext) {
          if (messages.length > 0 && messages[0].role === 'system') {
            messages[0] = {
              ...messages[0],
              content: `${messages[0].content}\n\n${graphContext.formattedContext}`,
            };
          } else {
            messages.unshift({
              role: 'system',
              content: graphContext.formattedContext,
            });
            injectedSystemMessages++;
          }
          usedTokens += graphContext.tokenCount;
        }
      }
    }

    const entriesResult = await this.deps.memoryAdapter.getEntries({
      threadId: options.threadId,
      includeToolCalls: true,
    });

    let originalMessageCount = 0;
    let truncated = false;

    if (entriesResult.success) {
      const entries = entriesResult.data;
      originalMessageCount = entries.length;

      if (this.config.strategy === 'recent') {
        const selectedEntries = this.selectRecentEntries(entries, availableTokens - usedTokens);

        truncated = selectedEntries.length < entries.length;

        for (const entry of selectedEntries) {
          messages.push(entry.message);
          usedTokens += entry.tokenCount;
        }
      } else if (this.config.strategy === 'relevant') {
        const selectedEntries = await this.selectRelevantEntries(
          entries,
          availableTokens - usedTokens,
          options.currentInput
        );

        truncated = selectedEntries.length < entries.length;

        for (const entry of selectedEntries) {
          messages.push(entry.message);
          usedTokens += entry.tokenCount;
        }
      } else if (this.config.strategy === 'hybrid') {
        const selectedEntries = await this.selectHybridEntries(
          entries,
          availableTokens - usedTokens,
          options.currentInput
        );

        truncated = selectedEntries.length < entries.length;

        for (const entry of selectedEntries) {
          messages.push(entry.message);
          usedTokens += entry.tokenCount;
        }
      }
    }

    return {
      messages,
      facts,
      semanticResults,
      graphContext,
      tokenCount: usedTokens,
      truncated,
      metadata: {
        originalMessageCount,
        includedMessageCount: messages.length - injectedSystemMessages,
        factsIncluded: facts.length,
        semanticResultsIncluded: semanticResults.length,
        graphNodesIncluded: graphContext?.nodes.length ?? 0,
        graphEdgesIncluded: graphContext?.edges.length ?? 0,
      },
    };
  }

  private selectRecentEntries(entries: MemoryEntry[], availableTokens: number): MemoryEntry[] {
    const reversed = [...entries].reverse();
    const selected: MemoryEntry[] = [];
    let usedTokens = 0;

    for (const entry of reversed) {
      if (usedTokens + entry.tokenCount <= availableTokens) {
        selected.unshift(entry);
        usedTokens += entry.tokenCount;
      } else {
        continue;
      }
    }

    return selected;
  }

  /**
   * Entries most similar to the current input that fit the budget, in conversation order.
   * Falls back to the most recent entries when there is no input or embedding service.
   */
  private async selectRelevantEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput?: string
  ): Promise<MemoryEntry[]> {
    if (!currentInput || !this.deps.embeddingService) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const scored = await this.scoreEntries(entries, currentInput, 0);
    if (scored === null) {
      return this.selectRecentEntries(entries, availableTokens);
    }

    const selectedIds = new Set<string>();
    let usedTokens = 0;
    for (const { entry } of scored) {
      if (usedTokens + entry.tokenCount <= availableTokens) {
        selectedIds.add(entry.id);
        usedTokens += entry.tokenCount;
      }
    }

    return entries.filter((e) => selectedIds.has(e.id));
  }

  /**
   * Similarity of user/assistant text entries to the input, best first. Returns null when
   * embedding fails.
   */
  private async scoreEntries(
    entries: MemoryEntry[],
    input: string,
    minScore: number
  ): Promise<{ entry: MemoryEntry; score: number }[] | null> {
    const embeddingService = this.deps.embeddingService;
    if (!embeddingService) return null;

    const embeddable: { entry: MemoryEntry; text: string }[] = [];
    for (const entry of entries) {
      if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue;
      const content = entry.message.content;
      if (typeof content === 'string' && content.trim().length > 0) {
        embeddable.push({ entry, text: content });
      }
    }
    if (embeddable.length === 0) return [];

    try {
      const [inputVector, vectors] = await Promise.all([
        embeddingService.embed(input),
        embeddingService.embedBatch(embeddable.map((e) => e.text)),
      ]);
      return embeddable
        .map(({ entry }, i) => ({ entry, score: this.cosineSimilarity(inputVector, vectors[i]) }))
        .filter((s) => s.score > minScore)
        .sort((a, b) => b.score - a.score);
    } catch (err) {
      console.warn(
        'Embedding failed for context entries',
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  private async selectHybridEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput?: string
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
    const scoredEntries = (await this.scoreEntries(olderEntries, currentInput, 0.6)) ?? [];

    for (const { entry } of scoredEntries) {
      if (usedTokens + entry.tokenCount <= semanticBudget) {
        usedIds.add(entry.id);
        usedTokens += entry.tokenCount;
      }
    }

    const recentEntries = this.selectRecentEntries(
      entries.filter((e) => !usedIds.has(e.id)),
      availableTokens - usedTokens
    );
    for (const entry of recentEntries) usedIds.add(entry.id);

    return entries.filter((e) => usedIds.has(e.id));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
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
