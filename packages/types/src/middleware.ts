/**
 * Run middleware: hooks around the model and tool calls of an agent run
 */

import type { ChatRequest, ChatResponse } from './llm';
import type { Message, ToolCall, ToolResult } from './message';
import type { Tool, ToolInputAvailable, ToolInputDelta, ToolInputStart } from './tool';
import type { RunResult, ToolApprovalDecision, ToolApprovalRequest } from './runtime';
import type { Workspace } from './workspace';
import type { PermissionMode } from './permissions';

/**
 * What a middleware hook knows about the run it works in. `iteration` and the agent are those of
 * the moment the hook runs, so after a handoff they name the agent the run went on as.
 */
export interface RunMiddlewareContext<TDeps = unknown> {
  readonly runId: string;
  /** The run's thread. Unset for a tool call made with `invokeTool()` without a `threadId` */
  readonly threadId?: string;
  readonly agentId: string;
  readonly agentName: string;
  /**
   * The id the agent's long-term memory is kept under: its configured `id`, else its `name`.
   * Unset for a tool call made with `invokeTool()`
   */
  readonly memoryAgentId?: string;
  readonly userId?: string;
  /** The channel the run serves, as its tools get it */
  readonly channelType?: string;
  readonly channelId?: string;
  readonly topicId?: string;
  readonly conversationId?: string;
  /** The model turn the hook belongs to, from 1, or 0 before the first turn */
  readonly iteration: number;
  /** Aborts when the run is cancelled or times out */
  readonly signal: AbortSignal;
  /** The run's `deps`, as its tools get them */
  readonly deps?: TDeps;
  /**
   * The run's workspace (`RunOptions.workspace`, else the agent's), as its tools get it: for hooks
   * that checkpoint files or check whether a path is inside it (`contains`)
   */
  readonly workspace?: Workspace;
  /**
   * Values the run's middleware share, alive for the run (or the `invokeTool()` call). Not kept
   * in a paused run's checkpoint: a resumed run starts with an empty one.
   */
  readonly state: Map<string, unknown>;
  /** The run whose tool call started this one, for a delegated run (`agentAsTool()`) */
  readonly parentRunId?: string;
  /** The run's permission mode, when it has permissions set up */
  readonly permissionMode?: PermissionMode;
  /**
   * Adds text the model reads with the run's next model call, after the tool results of the
   * current step, saved to the thread as a system message. Unset outside a run (`invokeTool()`)
   */
  addContext?(text: string): void;
  /**
   * Ends the run before its next model call, with what it has: the run completes with
   * `stopped` set to the reason and the middleware. Unset outside a run (`invokeTool()`)
   */
  stop?(reason: string): void;
  /**
   * Writes a `custom` event to the run's thread log, `note` as its text. Unset when the call
   * has no thread to log to
   */
  logEvent?(event: RunLogEvent, note: string): Promise<void>;
}

/** A `custom` event a middleware writes to the thread log, see `RunMiddlewareContext.logEvent` */
export interface RunLogEvent extends Record<string, unknown> {
  /** What the event is about, such as `hook` */
  kind: string;
}

/** A run that starts, new or continued by `resume()`, for `startRun` */
export interface RunStartEvent {
  /** `startup` for a run on a thread without history, `resume` for one with history or a resume */
  readonly source: 'startup' | 'resume';
  /** Whether `resume()` continues a paused run */
  readonly resumed: boolean;
  /** The run's input (the paused run's input for a resume) */
  readonly input: string;
  /** The model the run starts on, as the agent names it */
  readonly model: string;
}

/** Context `startRun` or `beforeRun` adds to the conversation */
export interface RunContextUpdate {
  /**
   * Text the model reads: for `startRun` after the system prompt, for this run only (it is not
   * saved, a later run gets its own), for `beforeRun` after the input, saved with it
   */
  context?: string;
}

/** A tool call before the permissions decide it, for `beforeToolCall` */
export interface ToolCallEvent {
  /** The call as the model made it, or with the arguments a `beforeToolCall` hook before changed */
  readonly toolCall: ToolCall;
  readonly tool: Tool;
  /** Whether the call waited in a paused run that `resume()` continues */
  readonly resumed: boolean;
}

/**
 * What `beforeToolCall` says about a call: `deny` refuses it (the model reads `reason`), `ask`
 * asks a person even when the rules allow it, `allow` lets it run without asking when only the
 * mode or the tool's own approval setting would ask (a `deny` or `ask` rule still applies),
 * `defer` pauses the run with the call waiting for approval. `updatedArguments` replaces the
 * arguments: they pass the tool's schema and the permissions again. Several middleware: `deny`
 * wins over `defer`, over `ask`, over `allow`, and the last `updatedArguments` counts
 */
export interface ToolCallVerdict {
  decision?: 'allow' | 'deny' | 'ask' | 'defer';
  reason?: string;
  updatedArguments?: Record<string, unknown>;
}

/** A call that asks for approval, for `decideApproval` */
export interface ApprovalRequestEvent {
  readonly request: ToolApprovalRequest;
  readonly tool: Tool;
}

/** The calls of a step and their results, once every one resolved, for `afterToolBatch` */
export interface ToolBatchEvent {
  readonly calls: readonly { readonly toolCall: ToolCall; readonly result: ToolResult }[];
}

/** The agent would stop with its final answer, for `beforeStop` */
export interface RunStopEvent {
  readonly output: string;
  /** How many times in a row `beforeStop` hooks kept the run going, counted since its last tool call */
  readonly continuations: number;
  /**
   * Whether a `beforeStop` hook kept the run going since its last user message (its input, or a
   * message queued on its handle): Claude Code's `stop_hook_active`
   */
  readonly continued: boolean;
}

/** What keeps the run going instead of stopping, from `beforeStop` */
export interface RunStopUpdate {
  /** The message the agent goes on with, saved to the thread as a user message */
  continueWith: string;
}

/**
 * A compaction about to run: of a turn's conversation before a model call (`turn`, from
 * `context`) or of the thread after a run (`thread`, from `memory.compaction`). Both trigger on
 * their own (`auto`)
 */
export interface CompactionStartEvent {
  readonly trigger: 'auto';
  readonly scope: 'turn' | 'thread';
}

/** A compaction that ran, for `afterCompaction` */
export interface CompactionEndEvent extends CompactionStartEvent {
  /** The summary it wrote, when it wrote one */
  readonly summary?: string;
}

/** What `beforeCompaction` decides: `skip` leaves the conversation as it is */
export interface CompactionDecision {
  skip?: boolean;
  reason?: string;
}

/** A run about to change its model, for `beforeModelSwitch`: a handoff to an agent of another model */
export interface ModelSwitchEvent {
  /** `provider/model` the run is on */
  readonly from: string;
  /** `provider/model` it would go on with */
  readonly to: string;
  readonly reason: 'handoff';
  /** The agent the handoff goes to */
  readonly agent: string;
}

/** What `beforeModelSwitch` decides: `block` keeps the run on its agent and model, with why */
export interface ModelSwitchDecision {
  block?: string;
}

/**
 * Something a person should hear about: an approval the run asks for (`permission_prompt`), or a
 * question, plan or budget a paused run waits on (`agent_needs_input`)
 */
export interface RunNotification {
  readonly type: 'permission_prompt' | 'agent_needs_input';
  readonly message: string;
  readonly title?: string;
}

/**
 * The input of a new run, before it is saved to memory and before the first model turn. Audio
 * input is already transcribed into `input`.
 */
export interface RunInputEvent {
  readonly input: string;
  /** The messages the first turn starts from: the system prompt, the history and the input */
  readonly messages: readonly Message[];
}

/** The conversation as the next model turn is about to send it. */
export interface ModelTurnEvent {
  readonly messages: readonly Message[];
  /**
   * The model the turn is for, as the agent names it (or as cost routing picked it), before any
   * fallback: `provider/model`, or a bare model name on `llm.defaultProvider`
   */
  readonly model: string;
}

/** A change `beforeModel` makes to the run's conversation, for this turn and every later one. */
export interface ModelTurnUpdate {
  messages?: Message[];
}

/** Where a streamed model call sends its text and reasoning as they arrive. */
export interface ModelStreamSink {
  onToken(token: string): void;
  onReasoning?(delta: string): void;
  /** The model began to write a tool call */
  onToolInputStart?(event: ToolInputStart): void;
  /** The next piece of the JSON arguments of a tool call */
  onToolInputDelta?(event: ToolInputDelta): void;
  /** A tool call is complete, with its arguments read */
  onToolInputAvailable?(event: ToolInputAvailable): void;
}

/**
 * One call to a model: the request a backend gets, the model it goes to and, when the run
 * streams, where the call's text goes. A middleware hands `next` the call as it is or a changed
 * copy of it.
 */
export interface ModelCallRequest {
  /**
   * What the backend gets. `request.model` is the model name on that backend, without the
   * provider: change it to send the call to another model of the same provider, and the call is
   * priced and traced by that model
   */
  readonly request: ChatRequest;
  /**
   * `provider/model` the call goes to: the agent's model, or one of its `fallbackModels`. It names
   * the route and changing it has no effect
   */
  readonly model: string;
  /** Set when the run streams: what the call streams goes here */
  readonly stream?: ModelStreamSink;
}

export type ModelCallHandler = (call: ModelCallRequest) => Promise<ChatResponse>;

/** A model turn's answer, before the run uses it. */
export interface ModelResponseEvent {
  readonly response: ChatResponse;
  /** The conversation the answer replies to */
  readonly messages: readonly Message[];
  readonly model: string;
}

/**
 * A change `afterModel` makes to a turn's answer before the run uses it: `content` replaces its
 * text, `toolCalls` the calls it makes (an empty list makes it a final answer).
 */
export interface ModelResponseUpdate {
  content?: string;
  toolCalls?: ToolCall[];
}

/**
 * One tool call about to run, its arguments already checked against the tool's schema. To change
 * the arguments, hand `next` a `toolCall` with new ones: they are checked against the schema and
 * the tool's `requiresApproval` again, `args` of the layers inside is what the schema made of
 * them, and `approved` is false there, since nobody approved the new ones. The other fields stay
 * as they came. `onToolCall`, `RunResult.toolCalls` and spans keep the call as the model made it.
 */
export interface ToolCallRequest {
  readonly toolCall: ToolCall;
  readonly tool: Tool;
  /** The arguments as the tool's schema parsed them, defaults and transforms applied */
  readonly args: unknown;
  /** Whether a person approved this call, so guards that ask for approval let it through */
  readonly approved: boolean;
}

export type ToolCallHandler = (call: ToolCallRequest) => Promise<ToolResult>;

/**
 * Hooks around an agent run, for what applies to every model or tool call: masking, guards,
 * caching, retries, rewriting, logging. Register them in `middleware` of the Cogitator config,
 * the agent or the run.
 *
 * Order: the hooks of `hooks` (outermost), the Cogitator's middleware, then the agent's, then
 * the run's, then the built-in ones (PII masking, prompt injection, guardrails, tool output
 * clearing, compaction) closest to the model. `before*` hooks
 * run in that order, `wrap*` hooks nest with the first outermost, `afterModel` runs in reverse.
 *
 * A hook that throws fails the run with its error. `tripwire()` from `@cogitator-ai/core` stops
 * the run as a guard that tripped (`GUARDRAIL_TRIPPED`).
 */
export interface RunMiddleware<TDeps = unknown> {
  /** Names the middleware in errors and logs */
  readonly name: string;
  /**
   * A streamed run holds each turn's text back until the turn is done and the hooks have seen
   * it, then hands `onToken` the final text in one piece, so text a hook retries, blocks or
   * replaces (in `wrapModelCall` or `afterModel`) never reaches a listener.
   */
  readonly holdsStream?: boolean;
  /**
   * When a run starts, new or resumed, before its first model call: return `{ context }` to add
   * text after the system prompt, for this run only
   */
  startRun?(
    event: RunStartEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | RunContextUpdate | Promise<void | RunContextUpdate>;
  /**
   * Checks a new run's input before it is saved to memory and before the first model turn, and
   * the messages queued on its handle: throw to refuse it. Return `{ context }` to add text after
   * the input. Not called for `resume()`
   */
  beforeRun?(
    event: RunInputEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | RunContextUpdate | Promise<void | RunContextUpdate>;
  /** Before each model turn: return `{ messages }` to change the conversation from now on */
  beforeModel?(
    event: ModelTurnEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | ModelTurnUpdate | Promise<void | ModelTurnUpdate>;
  /**
   * Around each model call, once per model a turn tries: call `next` to send it (changed or
   * not, once or more), or answer without it.
   */
  wrapModelCall?(
    call: ModelCallRequest,
    next: ModelCallHandler,
    context: RunMiddlewareContext<TDeps>
  ): Promise<ChatResponse>;
  /** After each model turn's answer, before the run uses it */
  afterModel?(
    event: ModelResponseEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | ModelResponseUpdate | Promise<void | ModelResponseUpdate>;
  /**
   * Before the permissions decide a tool call (and before it asks for approval): refuse it, ask
   * for it, let it through, pause on it or change its arguments, see `ToolCallVerdict`. Called
   * again for a call that waited in a paused run once `resume()` continues it. The Cogitator's
   * middleware also see calls made with `invokeTool()`
   */
  beforeToolCall?(
    event: ToolCallEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | ToolCallVerdict | Promise<void | ToolCallVerdict>;
  /**
   * Answers a call that asks for approval before `onApproval` (and the guardrails'
   * `onToolApproval`) do, as a person would. Return nothing to leave it to them
   */
  decideApproval?(
    event: ApprovalRequestEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | ToolApprovalDecision | Promise<void | ToolApprovalDecision>;
  /**
   * Around each tool call that passed approval: call `next` to run it, or return a result of
   * your own. The Cogitator's middleware also wraps calls made with `invokeTool()`.
   */
  wrapToolCall?(
    call: ToolCallRequest,
    next: ToolCallHandler,
    context: RunMiddlewareContext<TDeps>
  ): Promise<ToolResult>;
  /**
   * Once every tool call of a step resolved, before the next model call. `context.addContext`
   * adds what the model reads with it, `context.stop` ends the run instead
   */
  afterToolBatch?(
    event: ToolBatchEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | Promise<void>;
  /**
   * When the agent would stop with a final answer: return `{ continueWith }` to keep it going with
   * that message instead. Not called once the run used every model turn it may take
   */
  beforeStop?(
    event: RunStopEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | RunStopUpdate | Promise<void | RunStopUpdate>;
  /** Before a compaction of the run's conversation or thread: return `{ skip: true }` to keep it */
  beforeCompaction?(
    event: CompactionStartEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | CompactionDecision | Promise<void | CompactionDecision>;
  /** After a compaction ran */
  afterCompaction?(
    event: CompactionEndEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | Promise<void>;
  /** Before the run changes its model: return `{ block }` to keep the one it is on */
  beforeModelSwitch?(
    event: ModelSwitchEvent,
    context: RunMiddlewareContext<TDeps>
  ): void | ModelSwitchDecision | Promise<void | ModelSwitchDecision>;
  /** When the run needs a person, see `RunNotification`. It cannot change what happens */
  onNotification?(
    event: RunNotification,
    context: RunMiddlewareContext<TDeps>
  ): void | Promise<void>;
  /**
   * When a run ends, before `run()` returns or throws: completed (it saved what it said already),
   * paused, or failed (`event.error`, an abort among them). For work that keeps memory in shape
   * for the next run, such as compaction (check `event.status === 'completed'` first), or that
   * cleans up after the run. An error it throws is logged, the run's outcome stays
   */
  afterRun?(event: RunEndEvent, context: RunMiddlewareContext<TDeps>): void | Promise<void>;
}

/** What every {@link RunEndEvent} carries */
export interface RunEndBase {
  /** The model the run ended on, as `provider/model` with its provider resolved */
  readonly model: string;
  /**
   * The id the agent's long-term memory (memory items) is kept under: its configured `id`, else
   * its `name`, so the memory of an agent created again with the same name is found again
   */
  readonly memoryAgentId: string;
}

/** A run that completed or paused, with its result */
export interface FinishedRunEnd extends RunEndBase {
  readonly status: 'completed' | 'paused';
  readonly result: RunResult;
  readonly error?: undefined;
}

/** A run that failed or was aborted, with the error `run()` throws */
export interface FailedRunEnd extends RunEndBase {
  readonly status: 'failed';
  readonly error: Error;
  readonly result?: undefined;
}

/** A run that ended, for `afterRun` */
export type RunEndEvent = FinishedRunEnd | FailedRunEnd;
