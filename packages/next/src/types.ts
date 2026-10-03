import type {
  Message,
  ToolCall,
  ToolResult,
  RunResult,
  ToolApprovalDecision,
} from '@cogitator-ai/types';
import type { PendingApproval } from './streaming/protocol.js';

export type { Message, ToolCall, ToolResult, RunResult, ToolApprovalDecision, PendingApproval };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** The model's reasoning summary for an assistant message, when the agent streams one */
  reasoning?: string;
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
}

export interface AgentHandlerOptions {
  parseInput?: (req: Request) => Promise<AgentInput>;
  beforeRun?: (req: Request, input: AgentInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
}

/** The decisions for the tool calls a paused run waits on */
export interface ResumeDecisions {
  /** Decisions by tool call id; calls left out pause the run again */
  decisions?: Record<string, ToolApprovalDecision>;
  /** Decision for every paused call `decisions` leaves out, e.g. one "approve all" answer */
  defaultDecision?: ToolApprovalDecision;
}

export interface ResumeInput extends ResumeDecisions {
  /** The thread of the paused run */
  threadId: string;
}

export interface ResumeHandlerOptions {
  parseInput?: (req: Request) => Promise<ResumeInput>;
  /** Return run options such as `{ userId }`: only the user the run belongs to may resume it */
  beforeRun?: (req: Request, input: ResumeInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
  /**
   * Answer in the chat stream protocol, like `createChatHandler`, so
   * `useCogitatorChat({ resumeApi })` streams the rest of the run. Default: JSON,
   * like `createAgentHandler`.
   */
  stream?: boolean;
}

export interface AgentResponse {
  output: string;
  threadId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Hidden reasoning tokens, already counted in `outputTokens` */
    reasoningTokens?: number;
    /** Input tokens read from the provider's prompt cache */
    cachedInputTokens?: number;
    /** Input tokens written to the provider's prompt cache */
    cacheWriteTokens?: number;
  };
  toolCalls: ToolCall[];
  trace?: {
    traceId: string;
    spans: unknown[];
  };
  /** The model's reasoning summary, when the agent asks for one (`reasoning.summary`) */
  reasoning?: string;
  /** `paused` when tool calls wait for approval; resume the run to go on */
  status?: 'completed' | 'paused';
  /** The tool calls a paused run waits on */
  pendingApprovals?: PendingApproval[];
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
  /** Pieces of the assistant's reasoning summary as they stream in */
  onReasoning?: (delta: string) => void;
  /** The run paused: these tool calls wait for `resume`, `approve` or `deny` */
  onApprovalRequired?: (approvals: PendingApproval[]) => void;
  /** Endpoint of a `createResumeHandler`, used by `resume`, `approve` and `deny` */
  resumeApi?: string;
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
  /** The tool calls the paused run of this thread waits on; empty when nothing is paused */
  pendingApprovals: PendingApproval[];
  /** Continues the paused run with these decisions and appends what the agent answers */
  resume: (decisions: ResumeDecisions) => Promise<void>;
  /** Approves every pending tool call and continues the run */
  approve: () => Promise<void>;
  /** Declines every pending tool call, telling the model `reason`, and continues the run */
  deny: (reason?: string) => Promise<void>;
}

export interface UseAgentOptions {
  api: string;
  /** Endpoint of a `createResumeHandler`, used by `resume` */
  resumeApi?: string;
  headers?: Record<string, string>;
  onError?: (error: Error) => void;
  onSuccess?: (result: AgentResponse) => void;
  retry?: RetryConfig;
}

export interface UseAgentReturn {
  run: (input: AgentInput) => Promise<void>;
  result: AgentResponse | null;
  /** The reasoning summary of the last result, when the agent returned one */
  reasoning: string | undefined;
  /** The tool calls the last result waits on, when the run paused for approval */
  pendingApprovals: PendingApproval[];
  /** Continues the paused run of the last result with these decisions */
  resume: (decisions: ResumeDecisions) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  reset: () => void;
}
