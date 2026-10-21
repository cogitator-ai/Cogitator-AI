import type {
  Message,
  LLMBackend,
  ModelRoute,
  ContextManagerConfig,
  CompressionResult,
  ContextState,
  CompressionStrategyHandler,
  CompressionContext,
} from '@cogitator-ai/types';
import {
  TruncateStrategy,
  SlidingWindowStrategy,
  SummarizeStrategy,
  HybridStrategy,
  countMessagesTokens,
} from './strategies/index';
import { parseModel } from '../llm/index';
import { modelContextWindow } from './model-window';
import { sanitizeToolHistory } from '../utils/tool-history';

export interface ContextManagerDeps {
  /** The backend and the model name for a model string; preferred over `getBackend`. */
  route?: (model: string) => ModelRoute;
  getBackend?: (model: string) => LLMBackend;
}

export class ContextManager {
  private config: Required<Omit<ContextManagerConfig, 'clearToolOutputs'>>;
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
    return modelContextWindow(modelString);
  }

  /**
   * Tokens the messages of a turn on `modelString` may take before they are compressed, or
   * `undefined` when compression is off.
   */
  compressionThreshold(modelString: string): number | undefined {
    return this.config.enabled ? this.limits(modelString).threshold : undefined;
  }

  private limits(modelString: string): { maxTokens: number; threshold: number } {
    const contextLimit = this.getModelContextLimit(modelString);
    const outputReserve = Math.floor(contextLimit * this.config.outputReserve);
    const maxTokens = contextLimit - outputReserve;
    return { maxTokens, threshold: Math.floor(maxTokens * this.config.compressionThreshold) };
  }

  checkState(messages: Message[], modelString: string): ContextState {
    const { maxTokens, threshold } = this.limits(modelString);

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

    const summarySource =
      this.config.summaryModel || (this.config.strategy === 'summarize' ? modelString : undefined);
    const summary = summarySource ? this.resolve(summarySource) : undefined;

    const ctx: CompressionContext = {
      messages,
      targetTokens: state.maxTokens,
      currentTokens: state.currentTokens,
      windowSize: this.config.windowSize,
      backend: summary?.backend,
      summaryModel: summary?.model,
    };

    const result = await this.strategy.compress(ctx);
    const messagesWithValidToolPairs = sanitizeToolHistory(result.messages);
    const unchanged =
      messagesWithValidToolPairs.length === result.messages.length &&
      messagesWithValidToolPairs.every((message, index) => message === result.messages[index]);
    if (unchanged) {
      return result;
    }

    return {
      ...result,
      messages: messagesWithValidToolPairs,
      compressedTokens: countMessagesTokens(messagesWithValidToolPairs),
    };
  }

  private resolve(modelString: string): Partial<ModelRoute> {
    if (this.deps.route) return this.deps.route(modelString);
    if (this.deps.getBackend) {
      return { backend: this.deps.getBackend(modelString), model: parseModel(modelString).model };
    }
    return {};
  }
}
