import type { ToolCall, ToolCallMessage } from '@cogitator-ai/types';

export function toolCallMessage(toolCalls: ToolCall[]): ToolCallMessage {
  return { role: 'assistant', content: '', toolCalls };
}
