import type {
  Message,
  LLMBackend,
  ContextManagerConfig,
  CompressionResult,
  ContextState,
  CompressionStrategyHandler,
  CompressionContext,
} from '@cogitator-ai/types';
import { getModel } from '@cogitator-ai/models';
import {
  TruncateStrategy,
  SlidingWindowStrategy,
  SummarizeStrategy,
  HybridStrategy,
  countMessagesTokens,
} from './strategies/index';
import { parseModel } from '../llm/index';

export interface ContextManagerDeps {
  getBackend?: (model: string) => LLMBackend;
}

export class ContextManager {
  private config: Required<Omit<ContextManagerConfig, 'windowOverlap'>>;
  private strategy: CompressionStrategyHandler;
  private deps: ContextManagerDeps;

  constructor(config: ContextManagerConfig, deps: ContextManagerDeps = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      strategy: config.strategy ?? 'hybrid',
      compressionThreshold: config.compressionThreshold ?? 0.8,
      outputReserve: config.outputReserve ?? 0.15,
      summaryModel: config.summaryModel ?? '',
      windowSize: config.windowSize ?? 10,
    };

    this.deps = deps;
    this.strategy = this.createStrategy(this.config.strategy);
  }

  private createStrategy(name: string): CompressionStrategyHandler {
    switch (name) {
      case 'truncate':
        return new TruncateStrategy();
      case 'sliding-window':
        return new SlidingWindowStrategy();
      case 'summarize':
        return new SummarizeStrategy();
      case 'hybrid':
      default:
        return new HybridStrategy();
    }
  }

  getModelContextLimit(modelString: string): number {
    const { model: modelId } = parseModel(modelString);
    const modelInfo = getModel(modelId);

    if (modelInfo?.contextWindow) {
      return modelInfo.contextWindow;
    }

    const lowerId = modelId.toLowerCase();
    if (lowerId.includes('gpt-4o')) return 128000;
    if (lowerId.includes('gpt-4.1')) return 128000;
    if (lowerId.includes('gpt-4')) return 8192;
    if (lowerId.includes('gpt-3.5')) return 16385;
    if (
      lowerId.includes('claude-3') ||
      lowerId.includes('claude-sonnet') ||
      lowerId.includes('claude-opus')
    )
      return 200000;
    if (lowerId.includes('claude-2')) return 100000;
    if (lowerId.includes('gemini-pro')) return 1000000;
    if (lowerId.includes('llama')) return 8192;
    if (lowerId.includes('mistral')) return 32768;

    return 8192;
  }

  checkState(messages: Message[], modelString: string): ContextState {
    const contextLimit = this.getModelContextLimit(modelString);
    const outputReserve = Math.floor(contextLimit * this.config.outputReserve);
    const maxTokens = contextLimit - outputReserve;
    const threshold = Math.floor(maxTokens * this.config.compressionThreshold);

    const currentTokens = countMessagesTokens(messages);
    const utilizationPercent = (currentTokens / maxTokens) * 100;
    const needsCompression = currentTokens > threshold;

    return {
      currentTokens,
      maxTokens,
      availableTokens: maxTokens - currentTokens,
      utilizationPercent,
      needsCompression,
    };
  }

  shouldCompress(messages: Message[], modelString: string): boolean {
    if (!this.config.enabled) return false;
    const state = this.checkState(messages, modelString);
    return state.needsCompression;
  }

  async compress(messages: Message[], modelString: string): Promise<CompressionResult> {
    const state = this.checkState(messages, modelString);

    if (!this.config.enabled || !state.needsCompression) {
      return {
        messages,
        originalTokens: state.currentTokens,
        compressedTokens: state.currentTokens,
        strategy: this.config.strategy,
      };
    }

    let backend: LLMBackend | undefined;
    let summaryModel = this.config.summaryModel;

    if (summaryModel && this.deps.getBackend) {
      backend = this.deps.getBackend(summaryModel);
    } else if (this.deps.getBackend && this.config.strategy === 'summarize') {
      summaryModel = modelString;
      backend = this.deps.getBackend(modelString);
    }

    const ctx: CompressionContext = {
      messages,
      targetTokens: state.maxTokens,
      currentTokens: state.currentTokens,
      windowSize: this.config.windowSize,
      backend,
      summaryModel: summaryModel ? parseModel(summaryModel).model : undefined,
    };

    return this.strategy.compress(ctx);
  }
}
