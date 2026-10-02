import type { Message, ToolCall } from '@cogitator-ai/types';

type AssistantWithToolCalls = Message & { toolCalls?: ToolCall[] };

function getToolCalls(message: Message): ToolCall[] {
  if (message.role !== 'assistant') return [];
  const toolCalls = (message as AssistantWithToolCalls).toolCalls;
  return Array.isArray(toolCalls) ? toolCalls : [];
}

function hasVisibleContent(message: Message): boolean {
  if (typeof message.content === 'string') return message.content.trim().length > 0;
  return message.content.length > 0;
}

/**
 * Repairs tool-calling structure in a message list so every provider accepts it.
 *
 * History windows, context compression and interrupted runs can cut a tool exchange in half:
 * a `tool` message whose assistant call was dropped, or an assistant tool call that never got
 * a result. Providers reject both shapes, so orphaned tool results are removed, unanswered
 * tool calls are stripped from their assistant message, and system messages that landed in
 * the middle of a tool exchange are moved right after it.
 */
export function sanitizeToolHistory(messages: Message[]): Message[] {
  const result: Message[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (message.role === 'tool') {
      index++;
      continue;
    }

    const toolCalls = getToolCalls(message);
    if (toolCalls.length === 0) {
      result.push(message);
      index++;
      continue;
    }

    const callIds = new Set(toolCalls.map((tc) => tc.id));
    const answered = new Set<string>();
    const toolMessages: Message[] = [];
    const deferredSystem: Message[] = [];

    let next = index + 1;
    while (next < messages.length) {
      const candidate = messages[next];
      if (candidate.role === 'tool') {
        const callId = candidate.toolCallId;
        if (callId && callIds.has(callId) && !answered.has(callId)) {
          answered.add(callId);
          toolMessages.push(candidate);
        }
      } else if (candidate.role === 'system') {
        deferredSystem.push(candidate);
      } else {
        break;
      }
      next++;
    }

    const keptCalls = toolCalls.filter((tc) => answered.has(tc.id));

    if (keptCalls.length === toolCalls.length) {
      result.push(message);
    } else if (keptCalls.length > 0) {
      result.push({ ...message, toolCalls: keptCalls } as AssistantWithToolCalls);
    } else if (hasVisibleContent(message)) {
      const plain: Message = { role: message.role, content: message.content };
      if (message.name !== undefined) plain.name = message.name;
      result.push(plain);
    }

    result.push(...toolMessages, ...deferredSystem);
    index = next;
  }

  return result;
}
