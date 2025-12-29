/**
 * Message types for LLM conversations
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolCallMessage extends Message {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolResultMessage extends Message {
  role: 'tool';
  content: string;
  toolCallId: string;
  name: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: unknown;
  error?: string;
}
