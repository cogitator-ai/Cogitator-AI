import type {
  Message,
  ToolCall,
  ToolResult,
  RunResult,
  ToolApprovalDecision,
  MultitaskStrategy,
} from '@cogitator-ai/types';
import type {
  AgentRunResponse,
  AnonymousPolicy,
  ContextPolicy,
  ResumableStreamOptions,
} from '@cogitator-ai/server-shared';
import type { DataEvent, PendingApproval, PendingInterrupt } from './streaming/protocol.js';
import type { RunAgentInput } from '@cogitator-ai/server-shared/agui';

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

/** A data part of an assistant message: structured data a tool sent, updated in place by id */
export interface ChatDataPart {
  id: string;
  /** What kind of data it is, such as `weather`, to pick how it renders */
  name: string;
  data: unknown;
  /** The tool call that sent it */
  toolCallId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** The model's reasoning summary for an assistant message, when the agent streams one */
  reasoning?: string;
  toolCalls?: ToolCall[];
  /** The data parts the run's tools sent, the latest of each id, transient ones left out */
  data?: ChatDataPart[];
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

/** The `params` of a dynamic route: a promise since Next 15, the object itself before */
export type RouteParams<P> = P | Promise<P>;

/** Who calls the inbox, as the `auth` of `createInboxHandler` establishes it */
export interface InboxCaller {
  userId?: string;
}

/** What `createInboxHandler` takes */
export interface InboxHandlerOptions {
  /**
   * Establishes the caller of a request: a caller sees and changes only the items of its
   * `userId`. An error it throws answers `401`, or the client error `status` it carries
   */
  auth?: (req: Request) => InboxCaller | undefined | Promise<InboxCaller | undefined>;
  /**
   * Whether a caller without a user id (no `userId`, or no `auth`) may read the inbox: `'allow'`
   * shows them the items without a user. Unset or `'deny'`: `401 UNAUTHORIZED`, so a handler
   * without `auth` shows nobody the results of routines that run unattended
   */
  anonymous?: AnonymousPolicy;
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
  /**
   * Keeps the stream of each run so a client that loses it can resume it. Every event then
   * carries an SSE `id`, and a client that disconnects no longer stops the run: it goes on, and
   * the same request again with `Last-Event-ID` (or `?lastEventId=`, which puts the id in URLs
   * and logs, so prefer the header) replays what the client missed and follows the run to its
   * end, `useCogitatorChat` does it by itself. `DELETE` on the route with `?streamId=` cancels
   * the run (export the handler as `DELETE` too). A reconnect and a cancel read no body and run
   * neither `beforeRun` nor `deps`: the stream is bound to `owner(req)`, and only a request with
   * the same owner may reconnect or cancel, after `authorizeThread` on the stream's thread. With
   * `beforeRun`, `owner` is required (it throws otherwise), without it every caller is
   * anonymous. A run nobody follows for `detachedTimeoutMs` (5 minutes) is stopped, so is every
   * run when `until` aborts. `true` keeps the events in the memory of this handler with the
   * default limits: give every instance one shared `store` where several serve the route.
   * Default: off, a client that disconnects stops the run.
   */
  resumableStreams?: boolean | ResumableStreamOptions<Request>;
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

export interface AGUIHandlerOptions extends ServerContractOptions {
  /**
   * Return run options such as `{ userId }` for the request: the run then acts for that user,
   * and only that user may resume its pause
   */
  beforeRun?: (req: Request, input: RunAgentInput) => Promise<Record<string, unknown> | void>;
  afterRun?: (result: RunResult) => Promise<void>;
  /**
   * How often a comment is written while the stream is open, in milliseconds, so a proxy or
   * the platform's idle timeout does not cut a run that waits on a slow tool. Default: 5000.
   * `0` turns heartbeats off.
   */
  sseHeartbeatMs?: number;
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
  /**
   * With `stream: true`, keeps the stream of each resumed run so a client that loses it can
   * resume it. Every event then
   * carries an SSE `id`, and a client that disconnects no longer stops the run: it goes on, and
   * the same request again with `Last-Event-ID` (or `?lastEventId=`, which puts the id in URLs
   * and logs, so prefer the header) replays what the client missed and follows the run to its
   * end, `useCogitatorChat` does it by itself. `DELETE` on the route with `?streamId=` cancels
   * the run (export the handler as `DELETE` too). A reconnect and a cancel read no body and run
   * neither `beforeRun` nor `deps`: the stream is bound to `owner(req)`, and only a request with
   * the same owner may reconnect or cancel, after `authorizeThread` on the stream's thread. With
   * `beforeRun`, `owner` is required (it throws otherwise), without it every caller is
   * anonymous. A run nobody follows for `detachedTimeoutMs` (5 minutes) is stopped, so is every
   * run when `until` aborts. `true` keeps the events in the memory of this handler with the
   * default limits: give every instance one shared `store` where several serve the route.
   * Default: off, a client that disconnects stops the run.
   */
  resumableStreams?: boolean | ResumableStreamOptions<Request>;
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
  /**
   * Every data part the stream sends, transient ones included, which never reach the message's
   * `data`: render a status that is gone once the run ends from here
   */
  onData?: (part: DataEvent) => void;
  /** The run's state each time it changes, see `state` of the hook */
  onStateChange?: (state: unknown) => void;
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
  /**
   * Resumes a stream that drops in the middle of a run, when the network fails or the body
   * ends before `finish`: the hook sends the request again with `Last-Event-ID` set to the last
   * event it got, and the message goes on where it stopped. It works with servers that keep
   * `resumableStreams`, which give every event an id: a stream without ids ends as before.
   * `attempts` is how many reconnects in a row may fail or bring no event (default 3), the
   * first after `delayMs` (default 1000), each next one twice as late. A stream the server no
   * longer keeps (`STREAM_NOT_FOUND`) or that lost events (`STREAM_RESUME_GAP`) ends with the
   * error. `false` turns reconnects off.
   */
  reconnect?: false | ReconnectConfig;
}

export interface ReconnectConfig {
  /** Reconnects in a row that may fail or bring no event. Default: 3 */
  attempts?: number;
  /** How long to wait before the first reconnect, in ms, each next one twice as long. Default: 1000 */
  delayMs?: number;
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
  /**
   * The state of the last run (`RunOptions.state`), as its tools changed it: whole from a
   * `state-snapshot`, patched by each `state-delta`. Undefined until a run sends one, and again after
   * `setThreadId` moves to another thread
   */
  state: unknown;
  /** Continues the paused run with these decisions and appends what the agent answers */
  resume: (decisions: ResumeDecisions) => Promise<void>;
  /** Approves every pending tool call and continues the run */
  approve: () => Promise<void>;
  /**
   * Approves every pending tool call and saves the `suggestedRule` of each, so calls like them
   * run without asking from now on (`remember: true`), then continues the run. For a rule or a
   * layer of your own, send `remember` with `resume`
   */
  approveAlways: () => Promise<void>;
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
