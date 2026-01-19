/**
 * Runtime types for Cogitator
 */

import type { Message, ToolCall, ToolResult } from './message';
import type { LLMProvider } from './llm';
import type { MemoryConfig } from './memory';
import type { SandboxManagerConfig } from './sandbox';
import type { ReflectionConfig, Reflection, ReflectionSummary } from './reflection';
import type { GuardrailConfig } from './constitutional';
import type { CostRoutingConfig } from './cost-routing';
import type { PromptOptimizationConfig } from './prompt-optimization';
import type { KnowledgeGraphConfig } from './knowledge-graph';

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
      mistral?: { apiKey: string };
      groq?: { apiKey: string };
      together?: { apiKey: string };
      deepseek?: { apiKey: string };
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
  /** Reflection configuration for self-analyzing agents */
  reflection?: ReflectionConfig;
  /** Constitutional AI guardrails configuration */
  guardrails?: GuardrailConfig;
  /** Cost-aware model routing configuration */
  costRouting?: CostRoutingConfig;
  /** Knowledge graph memory configuration */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** Prompt inspection and auto-optimization configuration */
  promptOptimization?: PromptOptimizationConfig;
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
  /** Callback when memory operation fails */
  onMemoryError?: (error: Error, operation: 'save' | 'load') => void;

  /** Execute tool calls in parallel. Default: false (sequential execution) */
  parallelToolCalls?: boolean;
}

export interface RunResult {
  readonly output: string;
  readonly structured?: unknown;
  readonly runId: string;
  readonly agentId: string;
  readonly threadId: string;
  /** Actual model used (may differ from agent.model if cost routing is enabled) */
  readonly modelUsed?: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cost: number;
    readonly duration: number;
  };
  readonly toolCalls: readonly ToolCall[];
  readonly messages: readonly Message[];
  readonly trace: {
    readonly traceId: string;
    readonly spans: readonly Span[];
  };
  readonly reflections?: readonly Reflection[];
  readonly reflectionSummary?: ReflectionSummary;
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
