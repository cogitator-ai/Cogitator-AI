/**
 * Runtime types for Cogitator
 */

import type { Message, ToolCall, ToolResult } from './message.js';
import type { LLMProvider } from './llm.js';

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
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
  attributes: Record<string, unknown>;
}
