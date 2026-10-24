import type {
  Message,
  ToolCall,
  ToolResult,
  RunResult,
  ToolApprovalDecision,
  MultitaskStrategy,
} from '@cogitator-ai/types';
import type { AgentRunResponse, AnonymousPolicy, ContextPolicy } from '@cogitator-ai/server-shared';
import type { PendingApproval, PendingInterrupt } from './streaming/protocol.js';

export type {
  Message,
  ToolCall,
  ToolResult,
  RunResult,
  ToolApprovalDecision,
  MultitaskStrategy,
  PendingApproval,
  PendingInterrupt,
};

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
  /** What the run does when its thread has a run going on. Default: the Cogitator's `multitaskStrategy` */
  multitaskStrategy?: MultitaskStrategy;
}

export interface AgentInput {
  input: string;
  context?: Record<string, unknown>;
  threadId?: string;
  /** What the run does when its thread has a run going on. Default: the Cogitator's `multitaskStrategy` */
  multitaskStrategy?: MultitaskStrategy;
}

/** What every handler takes to keep the server contract of the Cogitator adapters */
export interface ServerContractOptions {
  /**
   * Whether a caller without a user id (no `userId` in what `beforeRun` returned) may run
   * the agent: `'allow'` (the default) lets them, `'deny'` answers `401 UNAUTHORIZED`
   */
  anonymous?: AnonymousPolicy;
  /**
   * Decides whether the request may touch the thread it names, on top of the ownership check
   * of core: called with the request and the thread id, answering `false` refuses it with
   * `403 THREAD_FORBIDDEN` before the run starts
   */
  authorizeThread?: (req: Request, threadId: string) => boolean | Promise<boolean>;
  /**
   * The run's `deps` (`context.deps` of its tools) for the request, such as a database client
   * for the signed-in tenant. Never read from the body. What `beforeRun` returns comes after,
   * so a `deps` it returns wins
   */
  deps?: (req: Request) => unknown;
}

export interface ChatHandlerOptions extends ServerContractOptions {
  parseInput?: (req: Request) => Promise<ChatInput>;
  beforeRun?: (req: Request, input: ChatInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
  /**
   * Keys of the request's `metadata` that clients may set. The run adds them to the system prompt, so
   * by default (\`false\`) a request that sends any is refused with \`400\`. List the keys clients
   * may send, or pass \`true\` only for clients trusted like the server itself. A \`parseInput\`
   * of your own decides for itself.
   */
  acceptContext?: ContextPolicy;
  /**
   * How often a comment is written while the stream is open, in milliseconds, so a proxy or
   * the platform's idle timeout does not cut a run that waits on a slow tool. Default: 5000.
   * \`0\` turns heartbeats off.
   */
  sseHeartbeatMs?: number;
}

export interface AgentHandlerOptions extends ServerContractOptions {
  parseInput?: (req: Request) => Promise<AgentInput>;
  beforeRun?: (req: Request, input: AgentInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
  /**
   * Keys of the request's `context` that clients may set. The run adds them to the system prompt, so
   * by default (\`false\`) a request that sends any is refused with \`400\`. List the keys clients
   * may send, or pass \`true\` only for clients trusted like the server itself. A \`parseInput\`
   * of your own decides for itself.
   */
  acceptContext?: ContextPolicy;
}

/** The decisions for the tool calls a paused run waits on, and the answers to its questions */
export interface ResumeDecisions {
  /** Decisions by tool call id; calls left out pause the run again */
  decisions?: Record<string, ToolApprovalDecision>;
  /** Decision for every paused call `decisions` leaves out, e.g. one "approve all" answer */
  defaultDecision?: ToolApprovalDecision;
  /** Answers to the questions the run's tools asked, by interrupt id */
  responses?: Record<string, unknown>;
}

export interface ResumeInput extends ResumeDecisions {
  /** The thread of the paused run */
  threadId: string;
}

export interface ResumeHandlerOptions extends ServerContractOptions {
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
  /**
   * How often a comment is written while the stream is open, in milliseconds, so a proxy or
   * the platform's idle timeout does not cut a run that waits on a slow tool. Default: 5000.
   * \`0\` turns heartbeats off.
   */
  sseHeartbeatMs?: number;
}

/**
 * The JSON answer of \`createAgentHandler\` and \`createResumeHandler\`, the same as every
 * Cogitator adapter's: the output, thread, usage, tool calls and how the run ended
 * (\`status\`, \`truncated\`, \`blocked\`, \`structured\` and the others), never the system
 * prompt, the history or trace spans. \`traceId\` links it to the server's traces; read the
 * whole \`RunResult\` in \`afterRun\`.
 */
export type AgentResponse = AgentRunResponse;

export interface RetryConfig {
  maxRetries?: number;
  delay?: number;
  backoff?: 'linear' | 'exponential';
}

export interface ToolResultEvent {
  id: string;
  toolCallId: string;
  result: unknown;
  /** Data the tool gave the application only, never sent to the model */
  details?: unknown;
  /** How to show the call: a label, an icon and one line about it */
  presentation?: { label: string; icon?: string; detail?: string };
}

export interface UseChatOptions {
  api: string;
  threadId?: string;
  initialMessages?: ChatMessage[];
  headers?: Record<string, string>;
  onError?: (error: Error) => void;
  onFinish?: (message: ChatMessage) => void;
  /**
   * A tool call the stream announced. It is reported again with its new arguments when the
   * server corrects them (a `tool-update` with `arguments`)
   */
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (result: ToolResultEvent) => void;
  /**
   * A call the stream announced that never runs: the model never finished it, or the run did not
   * keep it. It is gone from the message's `toolCalls`, `onToolCall` may have reported it before
   */
  onToolCallDropped?: (toolCallId: string) => void;
  /** Pieces of the assistant's reasoning summary as they stream in */
  onReasoning?: (delta: string) => void;
  /** The run paused: these tool calls wait for `resume`, `approve` or `deny` */
  onApprovalRequired?: (approvals: PendingApproval[]) => void;
  /** The run paused for questions its tools asked: answer them with `resume({ responses })` */
  onInterruptRequired?: (interrupts: PendingInterrupt[]) => void;
  /** Endpoint of a `createResumeHandler`, used by `resume`, `approve` and `deny` */
  resumeApi?: string;
  /**
   * Sent with every message: what the run does when the thread already has a run going on.
   * Default: the server's `multitaskStrategy`
   */
  multitaskStrategy?: MultitaskStrategy;
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
  /** Continues the conversation of thread `id`, or starts a new one with `undefined`. */
  setThreadId: (id: string | undefined) => void;
  appendMessage: (message: ChatMessage) => void;
  clearMessages: () => void;
  setMessages: (messages: ChatMessage[]) => void;
  /** The tool calls the paused run of this thread waits on; empty when nothing is paused */
  pendingApprovals: PendingApproval[];
  /** The questions the paused run of this thread waits on; empty when it asked none */
  pendingInterrupts: PendingInterrupt[];
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
  /** The questions the last result waits on, when the run's tools asked any */
  pendingInterrupts: PendingInterrupt[];
  /** Continues the paused run of the last result with these decisions */
  resume: (decisions: ResumeDecisions) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
  reset: () => void;
}
