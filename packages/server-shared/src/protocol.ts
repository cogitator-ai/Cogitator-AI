import type { ToolPresentation } from '@cogitator-ai/types';
import { toRunUsage } from './usage.js';
import type { AgentRunOutcome } from './response.js';

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

export interface ToolCallEndEvent {
  type: 'tool-call-end';
  id: string;
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
}

/** A tool call waiting for approval; the shape of core's `ToolApprovalRequest` */
export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  description: string;
  sideEffects?: string[];
}

/** The run paused: these tool calls wait for a decision before it can go on */
export interface ApprovalRequiredEvent {
  type: 'approval-required';
  threadId: string;
  approvals: PendingApproval[];
}

/**
 * A question a paused run waits on, the shape of core's `RunInterrupt` without the answer:
 * `approval` for a tool call to approve, `input` for an answer a tool asked for
 */
export interface PendingInterrupt {
  id: string;
  kind: 'approval' | 'input';
  reason: string;
  message: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  toolCallId?: string;
  toolName?: string;
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

export function createToolCallEndEvent(id: string): ToolCallEndEvent {
  return { type: 'tool-call-end', id };
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
  update: Pick<ToolUpdateEvent, 'content' | 'details' | 'presentation'>
): ToolUpdateEvent {
  return {
    type: 'tool-update',
    toolCallId,
    ...(update.content !== undefined && { content: update.content }),
    ...(update.details !== undefined && { details: update.details }),
    ...(update.presentation && { presentation: update.presentation }),
  };
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
