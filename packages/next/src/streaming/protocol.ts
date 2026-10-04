/**
 * Token usage of a finished agent run, the same in the JSON response of
 * `createAgentHandler` and in the stream's `finish` event.
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

/**
 * The client-facing usage of a run: the token counts of core's `RunResult.usage`,
 * without its cost and duration, keeping only the optional counts the model reported.
 */
export function toRunUsage(usage: Readonly<Usage>): Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cachedInputTokens !== undefined && { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens !== undefined && { cacheWriteTokens: usage.cacheWriteTokens }),
  };
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
  | ApprovalRequiredEvent
  | ErrorEvent
  | FinishEvent;

export interface StartEvent {
  type: 'start';
  messageId: string;
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
  result: unknown;
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

export interface ErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

export interface FinishEvent {
  type: 'finish';
  messageId: string;
  usage?: Usage;
  threadId?: string;
}

export function createStartEvent(messageId: string): StartEvent {
  return { type: 'start', messageId };
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
  result: unknown
): ToolResultEvent {
  return { type: 'tool-result', id, toolCallId, result };
}

export function createApprovalRequiredEvent(
  threadId: string,
  approvals: readonly PendingApproval[]
): ApprovalRequiredEvent {
  return { type: 'approval-required', threadId, approvals: [...approvals] };
}

export function createErrorEvent(message: string, code?: string): ErrorEvent {
  return { type: 'error', message, code };
}

/**
 * The last event of a stream. `usage` goes through `toRunUsage`, so a run's `RunResult.usage`
 * can be passed as is: the event carries exactly the counts of the JSON response.
 */
export function createFinishEvent(
  messageId: string,
  usage?: Readonly<Usage>,
  threadId?: string
): FinishEvent {
  return { type: 'finish', messageId, usage: usage && toRunUsage(usage), threadId };
}
