import { describe, it, expect, vi } from 'vitest';
import { KoaStreamWriter } from '../streaming/koa-stream-writer.js';
import type { Context } from 'koa';
import type { ServerResponse } from 'http';

function mockCtx() {
  const chunks: string[] = [];
  const res = {
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    end: vi.fn(),
  } as unknown as ServerResponse;
  const ctx = { res } as Context;
  return { ctx, res, chunks };
}

function parseSSE(chunk: string): unknown {
  const match = /^data: (.+)\n\n$/.exec(chunk);
  if (!match) return null;
  if (match[1] === '[DONE]') return '[DONE]';
  return JSON.parse(match[1]);
}

describe('KoaStreamWriter', () => {
  it('start() writes a start event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.start('msg-1');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({ type: 'start', messageId: 'msg-1' });
  });

  it('textStart() writes text-start event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.textStart('txt-1');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({ type: 'text-start', id: 'txt-1' });
  });

  it('textDelta() skips empty strings', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.textDelta('txt-1', '');
    expect(chunks).toHaveLength(0);
  });

  it('textDelta() writes non-empty strings', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.textDelta('txt-1', 'hello');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({ type: 'text-delta', id: 'txt-1', delta: 'hello' });
  });

  it('textEnd() writes text-end event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.textEnd('txt-1');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({ type: 'text-end', id: 'txt-1' });
  });

  it('toolCallStart() writes tool-call-start event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.toolCallStart('tc-1', 'search');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({
      type: 'tool-call-start',
      id: 'tc-1',
      toolName: 'search',
    });
  });

  it('toolCallDelta() writes tool-call-delta event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.toolCallDelta('tc-1', '{"name":');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({
      type: 'tool-call-delta',
      id: 'tc-1',
      argsTextDelta: '{"name":',
    });
  });

  it('toolCallEnd() writes tool-call-end event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.toolCallEnd('tc-1');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({ type: 'tool-call-end', id: 'tc-1' });
  });

  it('toolResult() writes tool-result event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.toolResult('tr-1', 'tc-1', { answer: 42 });
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({
      type: 'tool-result',
      id: 'tr-1',
      toolCallId: 'tc-1',
      result: { answer: 42 },
    });
  });

  it('error() writes error event', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.error('something failed', 'INTERNAL');
    expect(chunks).toHaveLength(1);
    expect(parseSSE(chunks[0])).toEqual({
      type: 'error',
      message: 'something failed',
      code: 'INTERNAL',
    });
  });

  it('finish() writes finish event and [DONE] sentinel', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.finish('msg-1', { inputTokens: 5, outputTokens: 10, totalTokens: 15 });
    expect(chunks).toHaveLength(2);
    expect(parseSSE(chunks[0])).toEqual({
      type: 'finish',
      messageId: 'msg-1',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    });
    expect(parseSSE(chunks[1])).toBe('[DONE]');
  });

  it('finish() does nothing after close()', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.start('msg-1');
    writer.close();
    const countBefore = chunks.length;
    writer.finish('msg-1');
    expect(chunks).toHaveLength(countBefore);
  });

  it('close() calls res.end()', () => {
    const { ctx, res } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.close();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('close() is idempotent', () => {
    const { ctx, res } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.close();
    writer.close();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it('write methods are no-ops after close()', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.start('msg-1');
    writer.close();
    const countBefore = chunks.length;
    writer.textStart('txt-1');
    writer.textDelta('txt-1', 'hello');
    writer.textEnd('txt-1');
    writer.toolCallStart('tc-1', 'search');
    writer.toolCallDelta('tc-1', '{}');
    writer.toolCallEnd('tc-1');
    writer.toolResult('tr-1', 'tc-1', null);
    writer.error('boom', 'INTERNAL');
    expect(chunks).toHaveLength(countBefore);
  });

  it('isClosed getter works', () => {
    const { ctx } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    expect(writer.isClosed).toBe(false);
    writer.close();
    expect(writer.isClosed).toBe(true);
  });

  it('full protocol sequence produces correct events', () => {
    const { ctx, chunks } = mockCtx();
    const writer = new KoaStreamWriter(ctx);
    writer.start('msg-1');
    writer.textStart('txt-1');
    writer.textDelta('txt-1', 'hello ');
    writer.textDelta('txt-1', 'world');
    writer.textEnd('txt-1');
    writer.toolCallStart('tc-1', 'calculator');
    writer.toolCallDelta('tc-1', '{"expr":');
    writer.toolCallDelta('tc-1', '"2+2"}');
    writer.toolCallEnd('tc-1');
    writer.toolResult('tr-1', 'tc-1', 4);
    writer.finish('msg-1', { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    writer.close();

    const types = chunks.map((c) => {
      const parsed = parseSSE(c);
      if (parsed === '[DONE]') return '[DONE]';
      return (parsed as Record<string, unknown>).type;
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
