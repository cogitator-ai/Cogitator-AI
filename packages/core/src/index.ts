/**
 * @cogitator/core
 *
 * Core runtime for Cogitator AI agents
 */

export { Cogitator } from './cogitator.js';
export { Agent } from './agent.js';
export { tool, toolToSchema } from './tool.js';
export { ToolRegistry } from './registry.js';

// Built-in tools
export { calculator, datetime, builtinTools } from './tools/index.js';

// Logging
export { Logger, getLogger, setLogger, createLogger } from './logger.js';
export type { LogLevel, LogContext, LogEntry, LoggerOptions } from './logger.js';

// LLM backends
export {
  BaseLLMBackend,
  OllamaBackend,
  OpenAIBackend,
  AnthropicBackend,
  createLLMBackend,
  parseModel,
} from './llm/index.js';

// Re-export types
export type {
  // Agent
  AgentConfig,
  ResponseFormat,
  // Tool
  Tool,
  ToolConfig,
  ToolContext,
  ToolSchema,
  // Messages
  Message,
  MessageRole,
  ToolCall,
  ToolResult,
  // LLM
  LLMBackend,
  LLMProvider,
  LLMConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  // Runtime
  CogitatorConfig,
  RunOptions,
  RunResult,
  Span,
} from '@cogitator/types';
