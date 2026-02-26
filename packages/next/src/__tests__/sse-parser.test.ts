import { describe, it, expect } from 'vitest';
import { parseSSEStream } from '../client/sse-parser.js';
import type { StreamEvent } from '../streaming/protocol.js';

function createReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return stream.getReader();
}

describe('parseSSEStream', () => {
  it('parses single event', async () => {
    const reader = createReader(['data: {"type":"start","messageId":"msg_1"}\n\n']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'start', messageId: 'msg_1' }]);
  });

  it('parses multiple events in one chunk', async () => {
    const reader = createReader([
      'data: {"type":"start","messageId":"msg_1"}\n\ndata: {"type":"text-delta","id":"t1","delta":"Hi"}\n\n',
    ]);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'start', messageId: 'msg_1' });
    expect(events[1]).toEqual({ type: 'text-delta', id: 't1', delta: 'Hi' });
  });

  it('handles events split across chunks', async () => {
    const reader = createReader(['data: {"type":"sta', 'rt","messageId":"msg_1"}\n\n']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'start', messageId: 'msg_1' }]);
  });

  it('stops on [DONE] marker', async () => {
    const reader = createReader([
      'data: {"type":"start","messageId":"msg_1"}\n\ndata: [DONE]\n\ndata: {"type":"text-delta","id":"t1","delta":"late"}\n\n',
    ]);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });

  it('ignores SSE comments', async () => {
    const reader = createReader([': keep-alive\ndata: {"type":"start","messageId":"msg_1"}\n\n']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });

  it('ignores empty lines', async () => {
    const reader = createReader(['\n\n\ndata: {"type":"start","messageId":"msg_1"}\n\n']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });

  it('skips malformed JSON', async () => {
    const reader = createReader([
      'data: {broken\n\ndata: {"type":"start","messageId":"msg_1"}\n\n',
    ]);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'start', messageId: 'msg_1' });
  });

  it('handles trailing data in buffer', async () => {
    const reader = createReader(['data: {"type":"start","messageId":"msg_1"}']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: 'start', messageId: 'msg_1' }]);
  });

  it('handles empty stream', async () => {
    const reader = createReader([]);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it('handles [DONE] in trailing buffer', async () => {
    const reader = createReader(['data: [DONE]']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it('handles malformed JSON in trailing buffer', async () => {
    const reader = createReader(['data: {broken']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });

  it('handles non-data lines in buffer', async () => {
    const reader = createReader(['event: ping']);
    const events: StreamEvent[] = [];

    for await (const event of parseSSEStream(reader)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });
});
