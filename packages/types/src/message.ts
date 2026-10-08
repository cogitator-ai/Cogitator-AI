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
  /**
   * Opaque reasoning signature attached by the provider to this call.
   * Must be sent back unchanged with the call in follow-up requests (Gemini thought signatures).
   */
  thoughtSignature?: string;
  /**
   * Opaque provider state needed to replay this call unchanged in follow-up requests
   * (OpenAI Responses reasoning items). JSON-serializable so it survives memory persistence;
   * backends that did not produce it ignore it.
   */
  replay?: ToolCallReplayState;
  /**
   * Why the arguments the model sent for this call could not be read, such as JSON the provider
   * broke. The call keeps empty `arguments`, never runs or asks for approval, and the model gets
   * this reason as the call's error so it can call again.
   */
  argumentsError?: string;
}

/**
 * Provider output that has to travel with a tool call so stateless reasoning models can
 * continue their chain of thought on the next turn.
 */
export interface ToolCallReplayState {
  /** Provider id of the output item that carried the call (e.g. OpenAI Responses `fc_...`). */
  itemId?: string;
  /**
   * Output items the provider emitted right before the call, in order — e.g. OpenAI Responses
   * `reasoning` items with `encrypted_content` and preamble `message` items. They are sent back
   * verbatim immediately ahead of the call.
   */
  precedingItems?: Record<string, unknown>[];
  /**
   * Provider metadata of the call itself (an AI SDK tool call's `providerMetadata`), sent back
   * unchanged as the call's provider options.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  result: unknown;
  error?: string;
}
