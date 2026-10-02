import { describe, it, expect } from 'vitest';
import type { Message, ToolCall } from '@cogitator-ai/types';
import { sanitizeToolHistory } from '../utils/tool-history';

function assistantWithCalls(content: string, calls: ToolCall[]): Message {
  return { role: 'assistant', content, toolCalls: calls } as Message & { toolCalls: ToolCall[] };
}

function toolResult(id: string, content = '"ok"'): Message {
  return { role: 'tool', content, toolCallId: id, name: 'fn' };
}

const call = (id: string): ToolCall => ({ id, name: 'fn', arguments: {} });

describe('sanitizeToolHistory', () => {
  it('keeps complete tool exchanges untouched', () => {
    const messages: Message[] = [
      { role: 'user', content: 'go' },
      assistantWithCalls('', [call('a'), call('b')]),
      toolResult('a'),
      toolResult('b'),
      { role: 'assistant', content: 'done' },
    ];

    const result = sanitizeToolHistory(messages);

    expect(result).toHaveLength(messages.length);
    result.forEach((message, index) => expect(message).toBe(messages[index]));
  });

  it('drops tool results whose assistant call was cut off', () => {
    const result = sanitizeToolHistory([
      toolResult('a'),
      toolResult('b'),
      { role: 'user', content: 'next' },
    ]);

    expect(result).toEqual([{ role: 'user', content: 'next' }]);
  });

  it('strips unanswered calls and keeps answered ones', () => {
    const result = sanitizeToolHistory([
      assistantWithCalls('', [call('a'), call('b')]),
      toolResult('a'),
    ]);

    expect(result).toEqual([
      { role: 'assistant', content: '', toolCalls: [call('a')] },
      toolResult('a'),
    ]);
  });

  it('keeps assistant text when none of its calls were answered', () => {
    const result = sanitizeToolHistory([
      { role: 'user', content: 'q' },
      assistantWithCalls('Let me check', [call('a')]),
    ]);

    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'Let me check' },
    ]);
  });

  it('drops empty assistant messages whose calls were never answered', () => {
    const result = sanitizeToolHistory([
      { role: 'user', content: 'q' },
      assistantWithCalls('', [call('a')]),
      { role: 'user', content: 'again' },
    ]);

    expect(result).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('moves system messages out of the middle of a tool exchange', () => {
    const reflection: Message = { role: 'system', content: 'Reflection' };
    const result = sanitizeToolHistory([
      assistantWithCalls('', [call('a'), call('b')]),
      toolResult('a'),
      reflection,
      toolResult('b'),
    ]);

    expect(result.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'system']);
    expect(result[3]).toBe(reflection);
  });

  it('ignores duplicate and foreign tool results inside an exchange', () => {
    const result = sanitizeToolHistory([
      assistantWithCalls('', [call('a')]),
      toolResult('a', '"first"'),
      toolResult('a', '"second"'),
      toolResult('zzz'),
    ]);

    expect(result).toEqual([assistantWithCalls('', [call('a')]), toolResult('a', '"first"')]);
  });
});
