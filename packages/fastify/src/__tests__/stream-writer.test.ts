import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { FastifyStreamWriter } from '../streaming/fastify-stream-writer.js';

function mockReply() {
  const chunks: Buffer[] = [];
  let ended = false;
  let headersWritten = false;
  const rawStream = {
    writeHead: vi.fn((_status: number, _headers: Record<string, string>) => {
      headersWritten = true;
    }),
    write: vi.fn((chunk: string | Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }),
    end: vi.fn(() => {
      ended = true;
    }),
  };
  const reply = { raw: rawStream } as unknown as FastifyReply;
  return {
    reply,
    raw: rawStream,
    getOutput: () => chunks.map((c) => c.toString()).join(''),
    isEnded: () => ended,
    headersWritten: () => headersWritten,
  };
}

describe('FastifyStreamWriter', () => {
  it('start() writes SSE headers and start event', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' })
    );
    expect(raw.write).toHaveBeenCalled();
  });

  it('textDelta skips empty strings', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    const callsBefore = (raw.write as ReturnType<typeof vi.fn>).mock.calls.length;
    writer.textDelta('txt-1', '');
    expect((raw.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('toolCallDelta skips empty strings', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    const callsBefore = (raw.write as ReturnType<typeof vi.fn>).mock.calls.length;
    writer.toolCallDelta('tool-1', '');
    expect((raw.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('finish() writes finish event and [DONE] sentinel', () => {
    const { reply, getOutput } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.finish('msg-1');
    const output = getOutput();
    expect(output).toContain('[DONE]');
    expect(output).toContain('finish');
  });

  it('finish() does nothing after close()', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.close();
    const callsBefore = (raw.write as ReturnType<typeof vi.fn>).mock.calls.length;
    writer.finish('msg-1');
    expect((raw.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('write() calls after close() are no-ops', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.close();
    const callsBefore = (raw.write as ReturnType<typeof vi.fn>).mock.calls.length;
    writer.textDelta('txt-1', 'hello');
    writer.error('boom', 'INTERNAL');
    expect((raw.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it('close() ends the raw stream', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.close();
    expect(raw.end).toHaveBeenCalled();
  });

  it('double close() only ends the stream once', () => {
    const { reply, raw } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.close();
    writer.close();
    expect((raw.end as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('isClosed reflects closed state', () => {
    const { reply } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    expect(writer.isClosed).toBe(false);
    writer.start('msg-1');
    writer.close();
    expect(writer.isClosed).toBe(true);
  });

  it('error() writes error event', () => {
    const { reply, getOutput } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.error('something failed', 'INTERNAL');
    expect(getOutput()).toContain('error');
  });

  it('full protocol sequence produces valid SSE output', () => {
    const { reply, getOutput } = mockReply();
    const writer = new FastifyStreamWriter(reply);
    writer.start('msg-1');
    writer.textStart('txt-1');
    writer.textDelta('txt-1', 'hello ');
    writer.textDelta('txt-1', 'world');
    writer.textEnd('txt-1');
    writer.finish('msg-1', { inputTokens: 5, outputTokens: 10, totalTokens: 15 });
    writer.close();
    const output = getOutput();
    expect(output).toContain('"type":"start"');
    expect(output).toContain('"type":"text-start"');
    expect(output).toContain('"type":"text-delta"');
    expect(output).toContain('"type":"text-end"');
    expect(output).toContain('"type":"finish"');
    expect(output).toContain('[DONE]');
  });
});
