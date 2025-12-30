/**
 * @cogitator/core
 *
 * Core runtime for Cogitator AI agents
 */

export { Cogitator } from './cogitator.js';
export { Agent } from './agent.js';
export { tool, toolToSchema } from './tool.js';
export { ToolRegistry } from './registry.js';

export { calculator, datetime, builtinTools } from './tools/index.js';

export { Logger, getLogger, setLogger, createLogger } from './logger.js';
export type { LogLevel, LogContext, LogEntry, LoggerOptions } from './logger.js';

export {
  BaseLLMBackend,
  OllamaBackend,
  OpenAIBackend,
  AnthropicBackend,
  createLLMBackend,
  parseModel,
} from './llm/index.js';

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
