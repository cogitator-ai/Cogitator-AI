/**
 * @cogitator/core
 *
 * Core runtime for Cogitator AI agents
 */

export { Cogitator } from './cogitator';
export { Agent } from './agent';
export { tool, toolToSchema } from './tool';
export { ToolRegistry } from './registry';

export { calculator, datetime, builtinTools } from './tools/index';

export { Logger, getLogger, setLogger, createLogger } from './logger';
export type { LogLevel, LogContext, LogEntry, LoggerOptions } from './logger';

export {
  BaseLLMBackend,
  OllamaBackend,
  OpenAIBackend,
  AnthropicBackend,
  createLLMBackend,
  parseModel,
} from './llm/index';

export {
  withRetry,
  retryable,
  CircuitBreaker,
  CircuitBreakerRegistry,
  withFallback,
  withGracefulDegradation,
  createLLMFallbackExecutor,
} from './utils/index';
export type {
  RetryOptions,
  CircuitBreakerOptions,
  CircuitBreakerStats,
  CircuitState,
  FallbackConfig,
  LLMFallbackConfig,
} from './utils/index';

export {
  CogitatorError,
  ErrorCode,
  ERROR_STATUS_CODES,
  isRetryableError,
  getRetryDelay,
} from '@cogitator/types';
export type { ErrorDetails, CogitatorErrorOptions } from '@cogitator/types';

export type {
  AgentConfig,
  ResponseFormat,
  Tool,
  ToolConfig,
  ToolContext,
  ToolSchema,
  Message,
  MessageRole,
  ToolCall,
  ToolResult,
  LLMBackend,
  LLMProvider,
  LLMConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  CogitatorConfig,
  RunOptions,
  RunResult,
  Span,
} from '@cogitator/types';
