export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  | FinishEvent
  | WorkflowEvent
  | SwarmEvent;

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
}

export interface WorkflowEvent {
  type: 'workflow';
  event: string;
  data: unknown;
}

export interface SwarmEvent {
  type: 'swarm';
  event: string;
  data: unknown;
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

export function createFinishEvent(messageId: string, usage?: Usage): FinishEvent {
  return { type: 'finish', messageId, usage };
}

export function createWorkflowEvent(event: string, data: unknown): WorkflowEvent {
  return { type: 'workflow', event, data };
}

export function createSwarmEvent(event: string, data: unknown): SwarmEvent {
  return { type: 'swarm', event, data };
}
