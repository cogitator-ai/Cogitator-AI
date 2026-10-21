import type { Message } from './message';
import type { LLMBackend } from './llm';
import type { ClearToolOutputsConfig } from './tool-output-clearing';

export type CompressionStrategy = 'truncate' | 'sliding-window' | 'summarize' | 'hybrid';

export interface ContextManagerConfig {
  /** Default: true. A Cogitator compresses context whenever `context` is set, unless this is false. */
  enabled?: boolean;
  strategy?: CompressionStrategy;
  compressionThreshold?: number;
  outputReserve?: number;
  summaryModel?: string;
  windowSize?: number;
  /**
   * Clears the outputs of old tool calls once a turn's conversation grows past a threshold, off
   * unless set (`true` takes the defaults). It works on its own: with `enabled: false` a
   * Cogitator clears tool outputs without compressing
   */
  clearToolOutputs?: boolean | ClearToolOutputsConfig;
}

export interface CompressionResult {
  messages: Message[];
  originalTokens: number;
  compressedTokens: number;
  strategy: CompressionStrategy;
  summarized?: number;
  truncated?: number;
}

export interface ContextState {
  currentTokens: number;
  maxTokens: number;
  availableTokens: number;
  utilizationPercent: number;
  needsCompression: boolean;
}

export interface CompressionContext {
  messages: Message[];
  targetTokens: number;
  currentTokens: number;
  windowSize: number;
  backend?: LLMBackend;
  summaryModel?: string;
}

export interface CompressionStrategyHandler {
  name: CompressionStrategy;
  compress(ctx: CompressionContext): Promise<CompressionResult>;
}
