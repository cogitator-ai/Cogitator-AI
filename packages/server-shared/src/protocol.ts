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
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ToolResultEvent
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
