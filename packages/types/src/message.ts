/**
 * Message types for LLM conversations
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type MessageContent = string | ContentPart[];

export type ContentPart = TextContentPart | ImageUrlContentPart | ImageBase64ContentPart;

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface ImageBase64ContentPart {
  type: 'image_base64';
  image_base64: {
    data: string;
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  };
}

export interface Message {
  role: MessageRole;
  content: MessageContent;
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
