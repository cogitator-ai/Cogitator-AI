import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { ExpressStreamWriter } from '../streaming/express-stream-writer.js';

function mockRes() {
  const written: string[] = [];
  return {
    write: vi.fn((data: string) => {
      written.push(data);
      return true;
    }),
    end: vi.fn(),
    flushHeaders: vi.fn(),
    setHeader: vi.fn(),
    _written: written,
  } as unknown as Response & { _written: string[] };
}

describe('ExpressStreamWriter', () => {
  it('writes start event', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.start('msg-1');

    expect(res.write).toHaveBeenCalledTimes(1);
    const data = res._written[0] as string;
    expect(data).toContain('msg-1');
  });

  it('skips empty string textDelta', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.textDelta('id-1', '');

    expect(res.write).not.toHaveBeenCalled();
  });

  it('writes whitespace textDelta (valid token)', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.textDelta('id-1', '   ');

    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it('writes non-empty textDelta', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.textDelta('id-1', 'hello');

    expect(res.write).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.close();
    writer.close();
    writer.close();

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('does not write after close()', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.close();
    writer.start('msg-1');
    writer.textDelta('id-1', 'token');

    expect(res.write).not.toHaveBeenCalled();
  });

  it('isClosed reflects state', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    expect(writer.isClosed).toBe(false);
    writer.close();
    expect(writer.isClosed).toBe(true);
  });

  it('writes finish event with usage', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.finish('msg-1', { inputTokens: 10, outputTokens: 20, totalTokens: 30 });

    const allData = res._written.join('');
    expect(allData).toContain('msg-1');
  });

  it('writes error event', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.error('something went wrong', 'INTERNAL');

    expect(res.write).toHaveBeenCalledTimes(1);
    const data = res._written[0] as string;
    expect(data).toContain('something went wrong');
  });

  it('writes tool call sequence', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.toolCallStart('tool-1', 'calculator');
    writer.toolCallDelta('tool-1', '{"a":1}');
    writer.toolCallEnd('tool-1');

    expect(res.write).toHaveBeenCalledTimes(3);
  });

  it('writes workflow event', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.workflowEvent('node_started', { nodeName: 'step1' });

    expect(res.write).toHaveBeenCalledTimes(1);
    const data = res._written[0] as string;
    expect(data).toContain('node_started');
  });

  it('writes swarm event', () => {
    const res = mockRes();
    const writer = new ExpressStreamWriter(res);

    writer.swarmEvent('agent_start', { agentName: 'worker-1' });

    expect(res.write).toHaveBeenCalledTimes(1);
    const data = res._written[0] as string;
    expect(data).toContain('agent_start');
  });
});
