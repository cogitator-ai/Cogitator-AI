import type { Message } from './message';
import type { LLMBackend } from './llm';

export type CompressionStrategy = 'truncate' | 'sliding-window' | 'summarize' | 'hybrid';

export interface ContextManagerConfig {
  /** Default: true. A Cogitator compresses context whenever `context` is set, unless this is false. */
  enabled?: boolean;
  strategy?: CompressionStrategy;
  compressionThreshold?: number;
  outputReserve?: number;
  summaryModel?: string;
  windowSize?: number;
  windowOverlap?: number;
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
