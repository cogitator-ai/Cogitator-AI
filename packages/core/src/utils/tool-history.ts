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

/** What the model reads for a tool call a run did not start before it was aborted */
export const ABORTED_BEFORE_DISPATCH =
  'Aborted before dispatch: the run stopped before this tool call started';

/** What the model reads for a tool call whose run stopped while it ran, as history restores it */
export const OUTCOME_UNKNOWN =
  'The run stopped before this tool call returned: outcome unknown, verify before retrying';

/**
 * A history restored from memory with an answer for every tool call left without one, such as
 * the calls a crashed or aborted run had going ({@link OUTCOME_UNKNOWN}), so the model knows they
 * may have run. The answers are only in the messages, the thread's log is not rewritten.
 */
export function repairUnansweredToolCalls(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    result.push(message);
    index++;
    const toolCalls = getToolCalls(message);
    if (toolCalls.length === 0) continue;
    let end = index;
    while (
      end < messages.length &&
      (messages[end].role === 'tool' || messages[end].role === 'system')
    ) {
      end++;
    }
    const exchange = messages.slice(index, end);
    const tools = exchange.filter((candidate) => candidate.role === 'tool');
    for (const call of toolCalls) {
      const answer = tools.find((candidate) => candidate.toolCallId === call.id);
      result.push(
        answer ?? {
          role: 'tool',
          content: JSON.stringify({ error: OUTCOME_UNKNOWN }),
          toolCallId: call.id,
          name: call.name,
        }
      );
    }
    const callIds = new Set(toolCalls.map((call) => call.id));
    result.push(...tools.filter((candidate) => !callIds.has(candidate.toolCallId ?? '')));
    result.push(...exchange.filter((candidate) => candidate.role === 'system'));
    index = end;
  }
  return result;
}
