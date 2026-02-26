import { describe, it, expect } from 'vitest';
import {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createToolCallStartEvent,
  createToolCallDeltaEvent,
  createToolCallEndEvent,
  createToolResultEvent,
  createErrorEvent,
  createFinishEvent,
} from '../streaming/protocol.js';

describe('protocol event factories', () => {
  it('creates start event', () => {
    expect(createStartEvent('msg_1')).toEqual({ type: 'start', messageId: 'msg_1' });
  });

  it('creates text-start event', () => {
    expect(createTextStartEvent('txt_1')).toEqual({ type: 'text-start', id: 'txt_1' });
  });

  it('creates text-delta event', () => {
    expect(createTextDeltaEvent('txt_1', 'Hello')).toEqual({
      type: 'text-delta',
      id: 'txt_1',
      delta: 'Hello',
    });
  });

  it('creates text-end event', () => {
    expect(createTextEndEvent('txt_1')).toEqual({ type: 'text-end', id: 'txt_1' });
  });

  it('creates tool-call-start event', () => {
    expect(createToolCallStartEvent('tc_1', 'search')).toEqual({
      type: 'tool-call-start',
      id: 'tc_1',
      toolName: 'search',
    });
  });

  it('creates tool-call-delta event', () => {
    expect(createToolCallDeltaEvent('tc_1', '{"q":"test"}')).toEqual({
      type: 'tool-call-delta',
      id: 'tc_1',
      argsTextDelta: '{"q":"test"}',
    });
  });

  it('creates tool-call-end event', () => {
    expect(createToolCallEndEvent('tc_1')).toEqual({ type: 'tool-call-end', id: 'tc_1' });
  });

  it('creates tool-result event', () => {
    expect(createToolResultEvent('tr_1', 'tc_1', { data: 'ok' })).toEqual({
      type: 'tool-result',
      id: 'tr_1',
      toolCallId: 'tc_1',
      result: { data: 'ok' },
    });
  });

  it('creates error event', () => {
    expect(createErrorEvent('fail')).toEqual({ type: 'error', message: 'fail' });
  });

  it('creates error event with code', () => {
    expect(createErrorEvent('fail', 'ERR_001')).toEqual({
      type: 'error',
      message: 'fail',
      code: 'ERR_001',
    });
  });

  it('creates finish event without usage', () => {
    expect(createFinishEvent('msg_1')).toEqual({ type: 'finish', messageId: 'msg_1' });
  });

  it('creates finish event with usage', () => {
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    expect(createFinishEvent('msg_1', usage)).toEqual({
      type: 'finish',
      messageId: 'msg_1',
      usage,
    });
  });
});
