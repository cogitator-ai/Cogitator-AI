import { describe, it, expect } from 'vitest';
import type { ToolCall, ToolResult } from '@cogitator-ai/types';
import { createToolMessage } from '../cogitator/tool-executor';

const toolCall: ToolCall = {
  id: 'tc_1',
  name: 'search',
  arguments: { query: 'hello' },
};

describe('createToolMessage', () => {
  it('includes error in content when result has error', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: null,
      error: 'Tool not found: search',
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('tc_1');
    expect(msg.name).toBe('search');

    const parsed = JSON.parse(msg.content as string);
    expect(parsed.error).toBe('Tool not found: search');
  });

  it('returns JSON of result when no error', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: { items: [1, 2, 3], total: 3 },
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.role).toBe('tool');
    const parsed = JSON.parse(msg.content as string);
    expect(parsed).toEqual({ items: [1, 2, 3], total: 3 });
  });

  it('returns "null" when result is null', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: null,
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.content).toBe('null');
  });

  it('returns "null" when result is undefined', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: undefined,
    };

    const msg = createToolMessage(toolCall, result);

    expect(msg.content).toBe('null');
  });

  it('returns string result correctly', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: 'success',
    };

    const msg = createToolMessage(toolCall, result);

    expect(JSON.parse(msg.content as string)).toBe('success');
  });

  it('prioritizes error over result', () => {
    const result: ToolResult = {
      callId: 'tc_1',
      name: 'search',
      result: { data: 'some data' },
      error: 'Timeout exceeded',
    };

    const msg = createToolMessage(toolCall, result);

    const parsed = JSON.parse(msg.content as string);
    expect(parsed.error).toBe('Timeout exceeded');
    expect(parsed.data).toBeUndefined();
  });
});
