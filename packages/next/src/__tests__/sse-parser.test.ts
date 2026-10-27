import { describe, it, expect } from 'vitest';
import { parseSSEFrames, parseSSEStream, type SSEFrame } from '../client/sse-parser.js';
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

describe('parseSSEFrames', () => {
  async function frames(chunks: string[]): Promise<SSEFrame[]> {
    const read: SSEFrame[] = [];
    for await (const frame of parseSSEFrames(createReader(chunks))) read.push(frame);
    return read;
  }

  const end = '{"type":"text-end","id":"t"}';

  it('gives an event the id written before its data', async () => {
    expect(await frames([`id: s:1\ndata: ${end}\n\n`])).toEqual([
      { event: { type: 'text-end', id: 't' }, id: 's:1' },
    ]);
  });

  it('gives an event the id written after its data, as Hono writes it', async () => {
    expect(await frames([`data: ${end}\nid: s:2\n\n`])).toEqual([
      { event: { type: 'text-end', id: 't' }, id: 's:2' },
    ]);
  });

  it('keeps the last id for the events that carry none, as EventSource does', async () => {
    const read = await frames([`id: s:3\ndata: ${end}\n\ndata: ${end}\n\n`]);
    expect(read.map((frame) => frame.id)).toEqual(['s:3', 's:3']);
  });

  it('forgets the id on an empty id field, and ignores one with NUL', async () => {
    const read = await frames([
      `id: s:4\ndata: ${end}\n\nid\ndata: ${end}\n\nid: s:\u00005\ndata: ${end}\n\n`,
    ]);
    expect(read.map((frame) => frame.id)).toEqual(['s:4', undefined, undefined]);
  });

  it('reads ids split across chunks and with CRLF line ends', async () => {
    const read = await frames([`id: s:`, `6\r\ndata: ${end}\r\n\r\n`]);
    expect(read).toEqual([{ event: { type: 'text-end', id: 't' }, id: 's:6' }]);
  });

  it('has no id where the server sends none', async () => {
    expect((await frames([`data: ${end}\n\n`]))[0]?.id).toBeUndefined();
  });
});
