/**
 * Run middleware: hooks around the model and tool calls of an agent run
 */

import type { ChatRequest, ChatResponse } from './llm';
import type { Message, ToolCall, ToolResult } from './message';
import type { Tool } from './tool';

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
  readonly userId?: string;
  /** The channel the run serves, as its tools get it */
  readonly channelType?: string;
  readonly channelId?: string;
  /** The model turn the hook belongs to, from 1, or 0 before the first turn */
  readonly iteration: number;
  /** Aborts when the run is cancelled or times out */
  readonly signal: AbortSignal;
  /** The run's `deps`, as its tools get them */
  readonly deps?: TDeps;
  /**
   * Values the run's middleware share, alive for the run (or the `invokeTool()` call). Not kept
   * in a paused run's checkpoint: a resumed run starts with an empty one.
   */
  readonly state: Map<string, unknown>;
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
 * Order: the Cogitator's middleware, then the agent's, then the run's, then the built-in ones
 * (PII masking, prompt injection, guardrails, tool output clearing, compaction) closest to the
 * model. `before*` hooks
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
   * Checks a new run's input before it is saved to memory and before the first model turn. Not
   * called for `resume()`
   */
  beforeRun?(event: RunInputEvent, context: RunMiddlewareContext<TDeps>): void | Promise<void>;
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
   * Around each tool call that passed approval: call `next` to run it, or return a result of
   * your own. The Cogitator's middleware also wraps calls made with `invokeTool()`.
   */
  wrapToolCall?(
    call: ToolCallRequest,
    next: ToolCallHandler,
    context: RunMiddlewareContext<TDeps>
  ): Promise<ToolResult>;
}
