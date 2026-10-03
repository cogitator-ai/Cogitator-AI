/**
 * Runtime types for Cogitator
 */

import type { Message, ToolCall, ToolResult } from './message';
import type { LLMBackend, LLMProvider, LLMProvidersConfig, LLMRetryConfig } from './llm';
import type { MemoryConfig } from './memory';
import type { SandboxManagerConfig } from './sandbox';
import type { ReflectionConfig, Reflection, ReflectionSummary } from './reflection';
import type { GuardrailConfig } from './constitutional';
import type { CostRoutingConfig } from './cost-routing';
import type { PromptInjectionConfig } from './security';
import type { DeployConfig } from './deploy';
import type { ContextManagerConfig } from './context';
import type { LoggingConfig } from './logging';

export interface CogitatorConfig {
  llm?: {
    defaultProvider?: LLMProvider;
    defaultModel?: string;
    providers?: LLMProvidersConfig;
    /**
     * Backends of your own, by name: an agent with model `name/model` (or
     * `provider: 'name'`) runs on it. A name of a built-in provider replaces it.
     */
    backends?: Record<string, LLMBackend>;
    /** Configuration passed to backend plugins registered with `registerLLMBackend`, by provider name. */
    plugins?: Record<string, unknown>;
    /**
     * Retries for failed LLM calls, on every backend the runtime uses; `false`
     * turns them off. On by default: 2 retries with exponential backoff.
     */
    retry?: LLMRetryConfig | false;
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
  /** Constitutional AI guardrails; fields left out take `DEFAULT_GUARDRAIL_CONFIG`. On unless `enabled: false`. */
  guardrails?: Partial<GuardrailConfig>;
  /** Cost-aware model routing configuration */
  costRouting?: CostRoutingConfig;
  /** Security configuration for prompt injection detection */
  security?: {
    /** Prompt injection detection; fields left out take the detector's defaults */
    promptInjection?: Partial<PromptInjectionConfig>;
  };
  /** Context management for long conversations (128k+ tokens) */
  context?: ContextManagerConfig;
  logging?: LoggingConfig;
  deploy?: DeployConfig;
}

export type ImageInput =
  string | { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' };

export type AudioFormat = 'mp3' | 'mp4' | 'mpeg' | 'mpga' | 'm4a' | 'wav' | 'webm' | 'ogg' | 'flac';

export type AudioInput = string | { data: string; format: AudioFormat };

export interface RunOptions {
  input: string;
  /** Images to include with the input. Can be URLs or base64 encoded data. */
  images?: ImageInput[];
  /** Audio files to transcribe and include with the input. Can be URLs or base64 encoded data. */
  audio?: AudioInput[];
  context?: Record<string, unknown>;
  threadId?: string;
  timeout?: number;
  /** Abort signal for cancelling the run. */
  signal?: AbortSignal;
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

  /**
   * The user the run acts for. It owns the threads the run creates, scopes the
   * facts and embeddings put into the context, and reaches tools as `context.userId`.
   */
  userId?: string;
  /**
   * Who may continue a given `threadId`. `'owner'` (default): only the user who
   * created the thread, so a client cannot read or extend another user's
   * conversation by sending its id; the run fails with `THREAD_ACCESS_DENIED`.
   * `'shared'`: anyone, for threads your server derives itself, such as a group
   * chat several users write to.
   */
  threadAccess?: 'owner' | 'shared';
  channelType?: string;
  channelId?: string;
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
