/**
 * Runtime types for Cogitator
 */

import type { Message, ToolCall, ToolResult } from './message';
import type { LLMProvider } from './llm';
import type { MemoryConfig } from './memory';
import type { SandboxManagerConfig } from './sandbox';

export interface CogitatorConfig {
  llm?: {
    defaultProvider?: LLMProvider;
    defaultModel?: string;
    providers?: {
      ollama?: { baseUrl: string };
      openai?: { apiKey: string; baseUrl?: string };
      anthropic?: { apiKey: string };
      google?: { apiKey: string };
      vllm?: { baseUrl: string };
    };
  };
  limits?: {
    maxConcurrentRuns?: number;
    defaultTimeout?: number;
    maxTokensPerRun?: number;
  };
  memory?: MemoryConfig;
  /** Sandbox configuration for isolated tool execution */
  sandbox?: SandboxManagerConfig;
}

export interface RunOptions {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
  timeout?: number;
  stream?: boolean;
  onToken?: (token: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;

  /** Enable/disable memory for this run. Default: true if adapter configured */
  useMemory?: boolean;
  /** Load conversation history from memory. Default: true */
  loadHistory?: boolean;
  /** Save messages to memory after each turn. Default: true */
  saveHistory?: boolean;

  /** Callback when run starts */
  onRunStart?: (data: { runId: string; agentId: string; input: string; threadId: string }) => void;
  /** Callback when run completes */
  onRunComplete?: (result: RunResult) => void;
  /** Callback when run fails */
  onRunError?: (error: Error, runId: string) => void;
  /** Callback when a span is created */
  onSpan?: (span: Span) => void;
}

export interface RunResult {
  output: string;
  structured?: unknown;
  runId: string;
  agentId: string;
  threadId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    duration: number;
  };
  toolCalls: ToolCall[];
  messages: Message[];
  trace: {
    traceId: string;
    spans: Span[];
  };
}

export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  status: 'ok' | 'error' | 'unset';
  startTime: number;
  endTime: number;
  duration: number;
  attributes: Record<string, unknown>;
  events?: { name: string; timestamp: number; attributes?: Record<string, unknown> }[];
}
