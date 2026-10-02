import { describe, it, expect } from 'vitest';
import { parseSSEStream } from '../client/sse-parser.js';
import type { StreamEvent } from '../streaming/protocol.js';

function readerFrom(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }).getReader();
}

async function collect(chunks: Uint8Array[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of parseSSEStream(readerFrom(chunks))) events.push(event);
  return events;
}

const encode = (s: string) => new TextEncoder().encode(s);

describe('parseSSEStream compatibility', () => {
  it('accepts data fields without a space after the colon', async () => {
    const events = await collect([encode('data:{"type":"start","messageId":"m"}\n\n')]);
    expect(events).toEqual([{ type: 'start', messageId: 'm' }]);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = encode('data: {"type":"text-delta","id":"t","delta":"привет"}\n\n');
    const split = bytes.indexOf(0xd0) + 1;
    const events = await collect([bytes.slice(0, split), bytes.slice(split)]);
    expect(events).toEqual([{ type: 'text-delta', id: 't', delta: 'привет' }]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect([
      encode('data: {"type":"text-end","id":"t"}\r\n\r\ndata: [DONE]\r\n'),
    ]);
    expect(events).toEqual([{ type: 'text-end', id: 't' }]);
  });

  it('parses multiple trailing lines without a final newline', async () => {
    const events = await collect([
      encode('data: {"type":"text-end","id":"a"}\ndata: {"type":"text-end","id":"b"}'),
    ]);
    expect(events).toEqual([
      { type: 'text-end', id: 'a' },
      { type: 'text-end', id: 'b' },
    ]);
  });
});
