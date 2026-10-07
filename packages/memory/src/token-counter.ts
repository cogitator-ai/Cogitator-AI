/**
 * Token counting utilities
 *
 * Uses simple estimation (~4 chars per token for English).
 * More accurate than nothing, avoids tiktoken WASM dependency.
 */

import type { ContentPart, MemoryEntry, Message, ToolCall } from '@cogitator-ai/types';

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const TOOL_CALL_OVERHEAD = 8;

/**
 * Tokens an image costs. Providers bill images by their pixel size, which a message does not
 * carry, so this is an upper estimate: about what Anthropic charges for an image at its maximum
 * size, and above OpenAI's high-detail cost for a 1024px image. `detail: 'low'` images are a
 * flat 85 tokens on OpenAI.
 */
const IMAGE_TOKENS = 1600;
const LOW_DETAIL_IMAGE_TOKENS = 85;

/**
 * Estimate token count for a string
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function countPartTokens(part: ContentPart): number {
  switch (part.type) {
    case 'text':
      return countTokens(part.text);
    case 'image_url':
      return part.image_url.detail === 'low' ? LOW_DETAIL_IMAGE_TOKENS : IMAGE_TOKENS;
    case 'image_base64':
      return IMAGE_TOKENS;
  }
}

function countContentTokens(content: Message['content']): number {
  if (typeof content === 'string') return countTokens(content);
  return content.reduce((sum, part) => sum + countPartTokens(part), 0);
}

/**
 * Estimate token count for tool calls: their names and JSON arguments
 */
export function countToolCallsTokens(toolCalls: readonly ToolCall[]): number {
  return toolCalls.reduce(
    (sum, call) =>
      sum +
      TOOL_CALL_OVERHEAD +
      countTokens(call.name) +
      countTokens(JSON.stringify(call.arguments ?? {})),
    0
  );
}

/** The tool calls an assistant message carries, when it carries any */
function toolCallsOf(message: Message): ToolCall[] | undefined {
  const toolCalls = (message as Message & { toolCalls?: unknown }).toolCalls;
  return Array.isArray(toolCalls) ? (toolCalls as ToolCall[]) : undefined;
}

/**
 * Estimate token count for a message: its text, images and tool calls, plus overhead
 */
export function countMessageTokens(message: Message): number {
  const toolCalls = toolCallsOf(message);
  return (
    countContentTokens(message.content) +
    MESSAGE_OVERHEAD +
    (toolCalls ? countToolCallsTokens(toolCalls) : 0)
  );
}

/**
 * Estimate token count for an array of messages
 */
export function countMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
}

/**
 * Tokens a stored entry takes in a context. Counted from its message and tool calls rather
 * than trusted from `tokenCount`, which may have been saved by an older estimate that left out
 * tool arguments and images; the larger of the two wins, so a count from a real tokenizer is
 * kept.
 */
export function countEntryTokens(entry: MemoryEntry): number {
  const messageCalls = toolCallsOf(entry.message);
  const entryCalls = !messageCalls && entry.toolCalls ? countToolCallsTokens(entry.toolCalls) : 0;
  return Math.max(entry.tokenCount ?? 0, countMessageTokens(entry.message) + entryCalls);
}

/**
 * Truncate text to fit within token limit
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const currentTokens = countTokens(text);
  if (currentTokens <= maxTokens) {
    return text;
  }

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  return text.slice(0, maxChars);
}
