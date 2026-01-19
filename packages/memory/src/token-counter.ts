/**
 * Token counting utilities
 *
 * Uses simple estimation (~4 chars per token for English).
 * More accurate than nothing, avoids tiktoken WASM dependency.
 */

import type { Message } from '@cogitator-ai/types';

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

/**
 * Estimate token count for a string
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Extract text content from a message
 */
function getTextContent(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

/**
 * Estimate token count for a message (includes overhead)
 */
export function countMessageTokens(message: Message): number {
  return countTokens(getTextContent(message.content)) + MESSAGE_OVERHEAD;
}

/**
 * Estimate token count for an array of messages
 */
export function countMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0);
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
