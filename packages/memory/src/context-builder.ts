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
} from '@cogitator/types';
import { countMessageTokens, countTokens } from './token-counter.js';

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
    // Default reserveTokens to 10% of maxTokens, minimum 100
    const defaultReserve = Math.max(100, Math.floor(config.maxTokens * 0.1));
    this.config = {
      maxTokens: config.maxTokens,
      reserveTokens: config.reserveTokens ?? defaultReserve,
      strategy: config.strategy,
      includeSystemPrompt: config.includeSystemPrompt ?? true,
      includeFacts: config.includeFacts ?? false,
      includeSemanticContext: config.includeSemanticContext ?? false,
    };
    this.deps = deps;
  }

  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const availableTokens =
      this.config.maxTokens - this.config.reserveTokens;
    let usedTokens = 0;
    const messages: Message[] = [];
    const facts: Fact[] = [];
    const semanticResults: Array<Embedding & { score: number }> = [];

    // 1. System prompt (always first if provided)
    if (this.config.includeSystemPrompt && options.systemPrompt) {
      const systemMsg: Message = { role: 'system', content: options.systemPrompt };
      const tokens = countMessageTokens(systemMsg);
      if (usedTokens + tokens <= availableTokens) {
        messages.push(systemMsg);
        usedTokens += tokens;
      }
    }

    // 2. Load and include facts if enabled
    if (this.config.includeFacts && this.deps.factAdapter) {
      const factsResult = await this.deps.factAdapter.getFacts(options.agentId);
      if (factsResult.success && factsResult.data.length > 0) {
        const factTokenBudget = Math.floor(availableTokens * 0.1); // 10% for facts
        let factTokens = 0;

        for (const fact of factsResult.data) {
          const tokens = countTokens(fact.content);
          if (factTokens + tokens <= factTokenBudget) {
            facts.push(fact);
            factTokens += tokens;
          }
        }

        // Append facts to system message
        if (facts.length > 0 && messages.length > 0 && messages[0].role === 'system') {
          const factsStr = facts.map((f) => `- ${f.content}`).join('\n');
          messages[0] = {
            ...messages[0],
            content: `${messages[0].content}\n\nKnown facts:\n${factsStr}`,
          };
          usedTokens += factTokens;
        }
      }
    }

    // 3. Load semantic context if enabled
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

        // Add semantic context to system message
        if (semanticResults.length > 0 && messages.length > 0 && messages[0].role === 'system') {
          const contextStr = semanticResults
            .map((r) => `- ${r.content}`)
            .join('\n');
          messages[0] = {
            ...messages[0],
            content: `${messages[0].content}\n\nRelevant context:\n${contextStr}`,
          };
          usedTokens += semanticTokens;
        }
      }
    }

    // 4. Load conversation history based on strategy
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
        // Take most recent messages that fit
        const selectedEntries = this.selectRecentEntries(
          entries,
          availableTokens - usedTokens
        );

        truncated = selectedEntries.length < entries.length;

        for (const entry of selectedEntries) {
          messages.push(entry.message);
          usedTokens += entry.tokenCount;
        }
      } else if (this.config.strategy === 'relevant') {
        // TODO: Implement relevance-based selection using embeddings
        // For now, fall back to recent
        const selectedEntries = this.selectRecentEntries(
          entries,
          availableTokens - usedTokens
        );
        truncated = selectedEntries.length < entries.length;

        for (const entry of selectedEntries) {
          messages.push(entry.message);
          usedTokens += entry.tokenCount;
        }
      } else if (this.config.strategy === 'hybrid') {
        // TODO: Combine recent + relevant
        const selectedEntries = this.selectRecentEntries(
          entries,
          availableTokens - usedTokens
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
      },
    };
  }

  private selectRecentEntries(
    entries: MemoryEntry[],
    availableTokens: number
  ): MemoryEntry[] {
    // Start from most recent and work backwards
    const reversed = [...entries].reverse();
    const selected: MemoryEntry[] = [];
    let usedTokens = 0;

    for (const entry of reversed) {
      if (usedTokens + entry.tokenCount <= availableTokens) {
        selected.unshift(entry); // Prepend to maintain order
        usedTokens += entry.tokenCount;
      } else {
        break;
      }
    }

    return selected;
  }
}
