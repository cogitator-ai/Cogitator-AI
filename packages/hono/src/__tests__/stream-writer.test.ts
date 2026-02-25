import { describe, it, expect, vi } from 'vitest';
import type { SSEStreamingApi } from 'hono/streaming';
import { HonoStreamWriter } from '../streaming/hono-stream-writer.js';

function mockStream() {
  const events: Array<{ data: string; event?: string }> = [];
  let aborted = false;
  const stream = {
    writeSSE: vi.fn(async (event: { data: string; event?: string }) => {
      events.push(event);
    }),
    abort: vi.fn(() => {
      aborted = true;
    }),
  };
  return { stream: stream as unknown as SSEStreamingApi, events, isAborted: () => aborted };
}

function parseEvent(events: Array<{ data: string; event?: string }>, index: number) {
  return JSON.parse(events[index].data);
}

describe('HonoStreamWriter', () => {
  it('start() writes a start event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.start('msg-1');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message');
    const parsed = parseEvent(events, 0);
    expect(parsed).toEqual({ type: 'start', messageId: 'msg-1' });
  });

  it('textDelta() skips empty strings', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.textDelta('txt-1', '');
    expect(events).toHaveLength(0);
  });

  it('textDelta() writes non-empty strings', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.textDelta('txt-1', 'hello');
    expect(events).toHaveLength(1);
    const parsed = parseEvent(events, 0);
    expect(parsed).toEqual({ type: 'text-delta', id: 'txt-1', delta: 'hello' });
  });

  it('toolCallDelta() skips empty strings', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.toolCallDelta('tool-1', '');
    expect(events).toHaveLength(0);
  });

  it('toolCallDelta() writes non-empty strings', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.toolCallDelta('tool-1', '{"name":');
    expect(events).toHaveLength(1);
    const parsed = parseEvent(events, 0);
    expect(parsed).toEqual({ type: 'tool-call-delta', id: 'tool-1', argsTextDelta: '{"name":' });
  });

  it('finish() writes finish event and [DONE] sentinel', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.finish('msg-1', { inputTokens: 5, outputTokens: 10, totalTokens: 15 });
    expect(events).toHaveLength(2);
    const parsed = parseEvent(events, 0);
    expect(parsed).toEqual({
      type: 'finish',
      messageId: 'msg-1',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    });
    expect(events[1]).toEqual({ data: '[DONE]', event: 'message' });
  });

  it('finish() does nothing after close()', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.start('msg-1');
    writer.close();
    const countBefore = events.length;
    await writer.finish('msg-1');
    expect(events).toHaveLength(countBefore);
  });

  it('write() calls after close() are no-ops', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.start('msg-1');
    writer.close();
    const countBefore = events.length;
    await writer.textDelta('txt-1', 'hello');
    await writer.error('boom', 'INTERNAL');
    await writer.textStart('txt-2');
    expect(events).toHaveLength(countBefore);
  });

  it('close() sets closed flag and calls stream.abort()', () => {
    const { stream, isAborted } = mockStream();
    const writer = new HonoStreamWriter(stream);
    expect(writer.isClosed).toBe(false);
    writer.close();
    expect(writer.isClosed).toBe(true);
    expect(isAborted()).toBe(true);
    expect(stream.abort).toHaveBeenCalledOnce();
  });

  it('close() is idempotent', () => {
    const { stream, isAborted } = mockStream();
    const writer = new HonoStreamWriter(stream);
    writer.close();
    writer.close();
    expect(isAborted()).toBe(true);
    expect(stream.abort).toHaveBeenCalledOnce();
  });

  it('textStart() writes text-start event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.textStart('txt-1');
    expect(parseEvent(events, 0)).toEqual({ type: 'text-start', id: 'txt-1' });
  });

  it('textEnd() writes text-end event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.textEnd('txt-1');
    expect(parseEvent(events, 0)).toEqual({ type: 'text-end', id: 'txt-1' });
  });

  it('toolCallStart() writes tool-call-start event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.toolCallStart('tc-1', 'search');
    expect(parseEvent(events, 0)).toEqual({
      type: 'tool-call-start',
      id: 'tc-1',
      toolName: 'search',
    });
  });

  it('toolCallEnd() writes tool-call-end event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.toolCallEnd('tc-1');
    expect(parseEvent(events, 0)).toEqual({ type: 'tool-call-end', id: 'tc-1' });
  });

  it('toolResult() writes tool-result event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.toolResult('tr-1', 'tc-1', { answer: 42 });
    expect(parseEvent(events, 0)).toEqual({
      type: 'tool-result',
      id: 'tr-1',
      toolCallId: 'tc-1',
      result: { answer: 42 },
    });
  });

  it('workflowEvent() writes workflow event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.workflowEvent('step-complete', { step: 3 });
    expect(parseEvent(events, 0)).toEqual({
      type: 'workflow',
      event: 'step-complete',
      data: { step: 3 },
    });
  });

  it('swarmEvent() writes swarm event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.swarmEvent('agent-joined', { agentId: 'a1' });
    expect(parseEvent(events, 0)).toEqual({
      type: 'swarm',
      event: 'agent-joined',
      data: { agentId: 'a1' },
    });
  });

  it('error() writes error event', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.error('something failed', 'INTERNAL');
    const parsed = parseEvent(events, 0);
    expect(parsed).toEqual({ type: 'error', message: 'something failed', code: 'INTERNAL' });
  });

  it('full protocol sequence produces correct events', async () => {
    const { stream, events } = mockStream();
    const writer = new HonoStreamWriter(stream);
    await writer.start('msg-1');
    await writer.textStart('txt-1');
    await writer.textDelta('txt-1', 'hello ');
    await writer.textDelta('txt-1', 'world');
    await writer.textEnd('txt-1');
    await writer.toolCallStart('tc-1', 'calculator');
    await writer.toolCallDelta('tc-1', '{"expr":');
    await writer.toolCallDelta('tc-1', '"2+2"}');
    await writer.toolCallEnd('tc-1');
    await writer.toolResult('tr-1', 'tc-1', 4);
    await writer.finish('msg-1', { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    writer.close();

    const types = events.map((e) => {
      if (e.data === '[DONE]') return '[DONE]';
      return JSON.parse(e.data).type;
    });
    expect(types).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'finish',
      '[DONE]',
    ]);
  });
});
