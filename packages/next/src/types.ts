import type { Message, ToolCall, ToolResult, RunResult } from '@cogitator-ai/types';

export type { Message, ToolCall, ToolResult, RunResult };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface ChatInput {
  messages: ChatMessage[];
  threadId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInput {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
}

export interface ChatHandlerOptions {
  parseInput?: (req: Request) => Promise<ChatInput>;
  beforeRun?: (req: Request, input: ChatInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
  maxDuration?: number;
}

export interface AgentHandlerOptions {
  parseInput?: (req: Request) => Promise<AgentInput>;
  beforeRun?: (req: Request, input: AgentInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
  maxDuration?: number;
}

export interface AgentResponse {
  output: string;
  threadId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCalls: ToolCall[];
  trace?: {
    traceId: string;
    spans: unknown[];
  };
}

export interface RetryConfig {
  maxRetries?: number;
  delay?: number;
  backoff?: 'linear' | 'exponential';
}

export interface ToolResultEvent {
  id: string;
  toolCallId: string;
  result: unknown;
}

export interface UseChatOptions {
  api: string;
  threadId?: string;
  initialMessages?: ChatMessage[];
  headers?: Record<string, string>;
  onError?: (error: Error) => void;
  onFinish?: (message: ChatMessage) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (result: ToolResultEvent) => void;
  retry?: RetryConfig;
}

export interface UseChatReturn {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  send: (input?: string, metadata?: Record<string, unknown>) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  stop: () => void;
  reload: () => Promise<void>;
  threadId: string | undefined;
  setThreadId: (id: string) => void;
  appendMessage: (message: ChatMessage) => void;
  clearMessages: () => void;
  setMessages: (messages: ChatMessage[]) => void;
}

export interface UseAgentOptions {
  api: string;
  headers?: Record<string, string>;
  onError?: (error: Error) => void;
  onSuccess?: (result: AgentResponse) => void;
  retry?: RetryConfig;
}

export interface UseAgentReturn {
  run: (input: AgentInput) => Promise<void>;
  result: AgentResponse | null;
  isLoading: boolean;
  error: Error | null;
  reset: () => void;
}
