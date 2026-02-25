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
  ContextBuilderConfig,
  BuiltContext,
  MemoryAdapter,
  FactAdapter,
  EmbeddingAdapter,
  EmbeddingService,
} from '@cogitator-ai/types';
import { countMessageTokens, countTokens } from './token-counter';

export interface ContextBuilderDeps {
  memoryAdapter: MemoryAdapter;
  factAdapter?: FactAdapter;
  embeddingAdapter?: EmbeddingAdapter;
  embeddingService?: EmbeddingService;
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
    const messages: Message[] = [];
    const facts: Fact[] = [];
    const semanticResults: (Embedding & { score: number })[] = [];

    if (this.config.includeSystemPrompt && options.systemPrompt) {
      const systemMsg: Message = { role: 'system', content: options.systemPrompt };
      const tokens = countMessageTokens(systemMsg);
      if (usedTokens + tokens <= availableTokens) {
        messages.push(systemMsg);
        usedTokens += tokens;
      }
    }

    if (this.config.includeFacts && this.deps.factAdapter) {
      const factsResult = await this.deps.factAdapter.getFacts(options.agentId);
      if (factsResult.success && factsResult.data.length > 0) {
        const factTokenBudget = Math.floor(availableTokens * 0.1);
        let factTokens = 0;

        for (const fact of factsResult.data) {
          const tokens = countTokens(fact.content);
          if (factTokens + tokens <= factTokenBudget) {
            facts.push(fact);
            factTokens += tokens;
          }
        }

        if (facts.length > 0) {
          const factsStr = facts.map((f) => `- ${f.content}`).join('\n');
          if (messages.length > 0 && messages[0].role === 'system') {
            messages[0] = {
              ...messages[0],
              content: `${messages[0].content}\n\nKnown facts:\n${factsStr}`,
            };
          } else {
            messages.unshift({
              role: 'system',
              content: `Known facts:\n${factsStr}`,
            });
          }
          usedTokens += factTokens;
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
      const searchResult = await this.deps.embeddingAdapter.search({
        vector,
        limit: 5,
        threshold: 0.7,
      });

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
          }
          usedTokens += semanticTokens;
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
        throw new Error(
          'Strategy "relevant" is not yet implemented. Use "recent" or enable includeSemanticContext for semantic search.'
        );
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
      tokenCount: usedTokens,
      truncated,
      metadata: {
        originalMessageCount,
        includedMessageCount:
          messages.length - (this.config.includeSystemPrompt && options.systemPrompt ? 1 : 0),
        factsIncluded: facts.length,
        semanticResultsIncluded: semanticResults.length,
        graphNodesIncluded: 0,
        graphEdgesIncluded: 0,
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
        break;
      }
    }

    return selected;
  }

  private async selectHybridEntries(
    entries: MemoryEntry[],
    availableTokens: number,
    currentInput?: string
  ): Promise<MemoryEntry[]> {
    const semanticBudget = Math.floor(availableTokens * 0.3);
    const recentBudget = availableTokens - semanticBudget;

    const selected: MemoryEntry[] = [];
    const usedIds = new Set<string>();
    let usedTokens = 0;

    if (currentInput && this.deps.embeddingService && entries.length > 10) {
      const inputVector = await this.deps.embeddingService.embed(currentInput);

      const olderEntries = entries.slice(0, -10);
      const scoredEntries: { entry: MemoryEntry; score: number }[] = [];

      for (const entry of olderEntries) {
        if (entry.message.role === 'user' || entry.message.role === 'assistant') {
          const content = entry.message.content;
          if (typeof content === 'string' && content.length > 20) {
            try {
              const entryVector = await this.deps.embeddingService.embed(content);
              const score = this.cosineSimilarity(inputVector, entryVector);
              if (score > 0.6) {
                scoredEntries.push({ entry, score });
              }
            } catch {}
          }
        }
      }

      scoredEntries.sort((a, b) => b.score - a.score);

      for (const { entry } of scoredEntries) {
        if (usedTokens + entry.tokenCount <= semanticBudget) {
          selected.push(entry);
          usedIds.add(entry.id);
          usedTokens += entry.tokenCount;
        }
      }
    }

    const recentEntries = this.selectRecentEntries(
      entries.filter((e) => !usedIds.has(e.id)),
      recentBudget
    );

    const semanticInOrder = entries.filter((e) => usedIds.has(e.id));
    return [...semanticInOrder, ...recentEntries];
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
