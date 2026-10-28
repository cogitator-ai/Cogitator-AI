import type { PermissionMode, ToolPresentation } from '@cogitator-ai/types';
import { toRunUsage } from './usage.js';
import type { AgentRunOutcome } from './response.js';
import type { JsonPatchOperation } from './json-patch.js';

/**
 * Token usage of a finished agent run, the same in the JSON run response and in the
 * stream's `finish` event.
 *
 * The provider-specific counts are present only when the model reported them.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Hidden reasoning tokens, already counted in `outputTokens` */
  reasoningTokens?: number;
  /** Input tokens read from the provider's prompt cache, already counted in `inputTokens` */
  cachedInputTokens?: number;
  /** Input tokens written to the provider's prompt cache, already counted in `inputTokens` */
  cacheWriteTokens?: number;
}

export type StreamEvent =
  | StartEvent
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ToolResultEvent
  | ToolUpdateEvent
  | DataEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | ResetStepEvent
  | ApprovalRequiredEvent
  | InterruptRequiredEvent
  | ErrorEvent
  | FinishEvent
  | WorkflowEvent
  | SwarmEvent;

export interface StartEvent {
  type: 'start';
  messageId: string;
  /**
   * The memory thread of an agent run: the one the request named, or the one the server
   * opened for it. Send it as `threadId` with the next message to continue the conversation.
   */
  threadId?: string;
}

export interface TextStartEvent {
  type: 'text-start';
  id: string;
}

export interface TextDeltaEvent {
  type: 'text-delta';
  id: string;
  delta: string;
}

export interface TextEndEvent {
  type: 'text-end';
  id: string;
}

/** A run of the model's reasoning summary, streamed like text (`reasoning.summary` on the agent) */
export interface ReasoningStartEvent {
  type: 'reasoning-start';
  id: string;
}

export interface ReasoningDeltaEvent {
  type: 'reasoning-delta';
  id: string;
  delta: string;
}

export interface ReasoningEndEvent {
  type: 'reasoning-end';
  id: string;
}

export interface ToolCallStartEvent {
  type: 'tool-call-start';
  id: string;
  toolName: string;
}

export interface ToolCallDeltaEvent {
  type: 'tool-call-delta';
  id: string;
  argsTextDelta: string;
}

/**
 * The model finished writing the tool call `id`. `dropped` when it stopped before the arguments
 * were complete: the call never runs, and a `tool-result` with `dropped` follows
 */
export interface ToolCallEndEvent {
  type: 'tool-call-end';
  id: string;
  dropped?: true;
}

export interface ToolResultEvent {
  type: 'tool-result';
  id: string;
  toolCallId: string;
  /** What the tool returned, absent when it returned nothing */
  result?: unknown;
  /** Data the tool gave the application only, never sent to the model */
  details?: unknown;
  /** How to show the call: a label, an icon and one line about it */
  presentation?: ToolPresentation;
  /**
   * The call never ran and has no result: the model never finished it (`incomplete`), or the run
   * did not keep it (`discarded`, such as a turn cut at the token limit). A client removes it
   */
  dropped?: true;
  reason?: 'incomplete' | 'discarded';
}

/**
 * What a running tool has so far (`context.update()` in the tool), sent between its
 * `tool-call-end` and its `tool-result`, as often as the tool reports it
 */
export interface ToolUpdateEvent {
  type: 'tool-update';
  toolCallId: string;
  content?: unknown;
  details?: unknown;
  presentation?: ToolPresentation;
  /**
   * The arguments the call runs with, when they differ from the ones its deltas streamed, such
   * as after an `afterModel` middleware changed them: they replace the streamed ones
   */
  arguments?: Record<string, unknown>;
}

/**
 * A data part: structured data a tool sent with `context.data()`, for the client to render as a
 * widget of its own. A `data` event with an id seen before replaces that part in place. A
 * `transient` part is shown while the stream lasts and never kept with the message
 */
export interface DataEvent {
  type: 'data';
  id: string;
  /** What kind of data it is, such as `weather`, for the client to pick how it renders it */
  name: string;
  data: unknown;
  transient?: true;
  /** The tool call that sent it */
  toolCallId?: string;
}

/** The run's whole state (`RunOptions.state`), sent when it is first set */
export interface StateSnapshotEvent {
  type: 'state-snapshot';
  snapshot: unknown;
}

/** How the run's state changed, as a JSON Patch (RFC 6902) on the state the client holds */
export interface StateDeltaEvent {
  type: 'state-delta';
  delta: JsonPatchOperation[];
}

/** A change of the run's state: the whole of it, or a JSON Patch on it */
export type StateEvent = StateSnapshotEvent | StateDeltaEvent;

/**
 * A step the model streamed is taken back and starts over (on a fallback model, or because its
 * answer came out empty): the client removes the text and reasoning parts `partIds` and the tool
 * calls `toolCallIds` it streamed, which never reach the conversation, and the step streams anew
 */
export interface ResetStepEvent {
  type: 'reset-step';
  partIds: string[];
  toolCallIds: string[];
}

/** A tool call waiting for approval; the shape of core's `ToolApprovalRequest` */
export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description: string;
  sideEffects?: string[];
  /** Why the call asks: the rule, the mode or the tool's own approval setting */
  reason?: string;
  /** The `ask` rule that made the call ask, as written, such as `Bash(git push *)` */
  rule?: string;
  /** The rule an "always allow" answer (`remember: true`) saves, such as `Bash(npm test *)` */
  suggestedRule?: string;
  /** The permission mode of the run */
  mode?: PermissionMode;
}

/** The run paused: these tool calls wait for a decision before it can go on */
export interface ApprovalRequiredEvent {
  type: 'approval-required';
  threadId: string;
  approvals: PendingApproval[];
}

/**
 * A question a paused run waits on, the shape of core's `RunInterrupt` without the answer:
 * `approval` for a tool call to approve, `input` for an answer a tool asked for, `plan` for a plan
 * to approve before the run leaves plan mode, `budget` for a budget the run reached
 */
export interface PendingInterrupt {
  id: string;
  kind: 'approval' | 'input' | 'plan' | 'budget';
  reason: string;
  message: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  toolCallId?: string;
  toolName?: string;
  /**
   * More to show the person who answers: the `plan` of a plan, the usage of a budget (`scope`,
   * `metric`, `used`, `limit`, `agentId`), the `reason`, `rule` and `suggestedRule` of an approval,
   * or what a tool passed with its question
   */
  details?: Record<string, unknown>;
}

/**
 * The run paused for questions its tools asked: answer them by id in `responses` when resuming
 * the thread. A pause for approvals only sends `approval-required`
 */
export interface InterruptRequiredEvent {
  type: 'interrupt-required';
  threadId: string;
  interrupts: PendingInterrupt[];
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

/**
 * The last event of a stream. For an agent run it also says how the run ended, with the
 * same fields as the JSON run response (`status`, `truncated`, `blocked` and the others).
 */
export interface FinishEvent extends Partial<AgentRunOutcome> {
  type: 'finish';
  messageId: string;
  usage?: Usage;
  /** The memory thread of an agent run, as in the `start` event */
  threadId?: string;
}

/** What the `finish` event of an agent run adds: its thread and how it ended */
export interface FinishDetails extends Partial<AgentRunOutcome> {
  threadId?: string;
}

export interface WorkflowEvent {
  type: 'workflow';
  event: string;
  data?: unknown;
}

export interface SwarmEvent {
  type: 'swarm';
  event: string;
  data?: unknown;
}

export function createStartEvent(messageId: string, threadId?: string): StartEvent {
  return { type: 'start', messageId, ...(threadId !== undefined && { threadId }) };
}

export function createTextStartEvent(id: string): TextStartEvent {
  return { type: 'text-start', id };
}

export function createTextDeltaEvent(id: string, delta: string): TextDeltaEvent {
  return { type: 'text-delta', id, delta };
}

export function createTextEndEvent(id: string): TextEndEvent {
  return { type: 'text-end', id };
}

export function createReasoningStartEvent(id: string): ReasoningStartEvent {
  return { type: 'reasoning-start', id };
}

export function createReasoningDeltaEvent(id: string, delta: string): ReasoningDeltaEvent {
  return { type: 'reasoning-delta', id, delta };
}

export function createReasoningEndEvent(id: string): ReasoningEndEvent {
  return { type: 'reasoning-end', id };
}

export function createToolCallStartEvent(id: string, toolName: string): ToolCallStartEvent {
  return { type: 'tool-call-start', id, toolName };
}

export function createToolCallDeltaEvent(id: string, argsTextDelta: string): ToolCallDeltaEvent {
  return { type: 'tool-call-delta', id, argsTextDelta };
}

export function createToolCallEndEvent(id: string, dropped = false): ToolCallEndEvent {
  return { type: 'tool-call-end', id, ...(dropped && { dropped: true as const }) };
}

/** The `tool-result` of a call that will never run, see `ToolResultEvent.dropped` */
export function createToolDroppedEvent(
  id: string,
  toolCallId: string,
  reason: 'incomplete' | 'discarded'
): ToolResultEvent {
  return { type: 'tool-result', id, toolCallId, dropped: true, reason };
}

export function createToolResultEvent(
  id: string,
  toolCallId: string,
  result: unknown,
  extras: Pick<ToolResultEvent, 'details' | 'presentation'> = {}
): ToolResultEvent {
  return {
    type: 'tool-result',
    id,
    toolCallId,
    result,
    ...(extras.details !== undefined && { details: extras.details }),
    ...(extras.presentation && { presentation: extras.presentation }),
  };
}

export function createToolUpdateEvent(
  toolCallId: string,
  update: Pick<ToolUpdateEvent, 'content' | 'details' | 'presentation' | 'arguments'>
): ToolUpdateEvent {
  return {
    type: 'tool-update',
    toolCallId,
    ...(update.content !== undefined && { content: update.content }),
    ...(update.details !== undefined && { details: update.details }),
    ...(update.presentation && { presentation: update.presentation }),
    ...(update.arguments && { arguments: update.arguments }),
  };
}

export function createDataEvent(part: {
  id: string;
  name: string;
  data: unknown;
  transient?: boolean;
  toolCallId?: string;
}): DataEvent {
  return {
    type: 'data',
    id: part.id,
    name: part.name,
    data: part.data,
    ...(part.transient === true && { transient: true as const }),
    ...(part.toolCallId !== undefined && { toolCallId: part.toolCallId }),
  };
}

export function createStateSnapshotEvent(snapshot: unknown): StateSnapshotEvent {
  return { type: 'state-snapshot', snapshot };
}

export function createStateDeltaEvent(delta: readonly JsonPatchOperation[]): StateDeltaEvent {
  return { type: 'state-delta', delta: [...delta] };
}

export function createResetStepEvent(
  partIds: readonly string[],
  toolCallIds: readonly string[]
): ResetStepEvent {
  return { type: 'reset-step', partIds: [...partIds], toolCallIds: [...toolCallIds] };
}

export function createApprovalRequiredEvent(
  threadId: string,
  approvals: readonly PendingApproval[]
): ApprovalRequiredEvent {
  return { type: 'approval-required', threadId, approvals: [...approvals] };
}

export function createInterruptRequiredEvent(
  threadId: string,
  interrupts: readonly PendingInterrupt[]
): InterruptRequiredEvent {
  return { type: 'interrupt-required', threadId, interrupts: [...interrupts] };
}

export function createErrorEvent(message: string, code?: string): ErrorEvent {
  return { type: 'error', message, code };
}

/**
 * The last event of a stream. `usage` goes through `toRunUsage`, so a run's `RunResult.usage`
 * can be passed as is: the event carries exactly the counts of the JSON run response.
 */
export function createFinishEvent(
  messageId: string,
  usage?: Readonly<Usage>,
  details: FinishDetails = {}
): FinishEvent {
  return { type: 'finish', messageId, usage: usage && toRunUsage(usage), ...details };
}

export function createWorkflowEvent(event: string, data: unknown): WorkflowEvent {
  return { type: 'workflow', event, data };
}

export function createSwarmEvent(event: string, data: unknown): SwarmEvent {
  return { type: 'swarm', event, data };
}
