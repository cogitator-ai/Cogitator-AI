import { describe, it, expect, vi } from 'vitest';
import { OTLPExporter } from '../observability/opentelemetry';
import type { Span } from '@cogitator-ai/types';

function makeSpan(id: string): Span {
  return {
    id,
    traceId: 'trace-1',
    name: `span-${id}`,
    kind: 'internal',
    status: 'ok',
    startTime: Date.now(),
    endTime: Date.now() + 100,
    duration: 100,
    attributes: { key: 'value' },
  };
}

describe('OTLPExporter', () => {
  async function exported(spans: Span[], status = 200) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: status < 400, status, statusText: 'x' });
    vi.stubGlobal('fetch', fetchMock);
    const exporter = new OTLPExporter({ endpoint: 'http://collector/v1/traces', enabled: true });
    for (const span of spans) exporter.exportSpan('run-1', span);
    await exporter.flush();
    vi.unstubAllGlobals();
    const body = fetchMock.mock.calls[0]?.[1]?.body as string | undefined;
    const sent = body
      ? (JSON.parse(body).resourceSpans[0].scopeSpans[0].spans as Array<Record<string, unknown>>)
      : [];
    return { exporter, sent };
  }

  it('sends OTLP hex ids and keeps parent links', async () => {
    const root = { ...makeSpan('span_root123'), traceId: 'trace_AbC-xyz_12345678' };
    const child = { ...makeSpan('span_child45'), traceId: root.traceId, parentId: root.id };

    const { sent } = await exported([root, child]);

    expect(sent[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[0].spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(sent[1].traceId).toBe(sent[0].traceId);
    expect(sent[1].parentSpanId).toBe(sent[0].spanId);
    expect(sent[0].parentSpanId).toBeUndefined();
  });

  it('keeps ids that already are OTLP hex', async () => {
    const span = {
      ...makeSpan('0af7651916cd43dd'),
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    };

    const { sent } = await exported([span]);

    expect(sent[0]).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '0af7651916cd43dd',
    });
  });

  it('types attributes and keeps the Cogitator ids', async () => {
    const span = {
      ...makeSpan('span_1'),
      startTime: 1_700_000_000_123,
      attributes: { tokens: 42, cost: 0.0125, cached: true, tool: 'search', args: { q: 'x' } },
    };

    const { sent } = await exported([span]);

    const attrs = Object.fromEntries(
      (sent[0].attributes as Array<{ key: string; value: unknown }>).map((a) => [a.key, a.value])
    );
    expect(attrs).toMatchObject({
      tokens: { intValue: '42' },
      cost: { doubleValue: 0.0125 },
      cached: { boolValue: true },
      tool: { stringValue: 'search' },
      args: { stringValue: '{"q":"x"}' },
      'cogitator.span_id': { stringValue: 'span_1' },
      'cogitator.run_id': { stringValue: 'run-1' },
    });
    expect(sent[0].startTimeUnixNano).toBe('1700000000123000000');
  });

  it('drops a batch the collector refuses and retries one it could not take', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const refused = await exported([makeSpan('a')], 400);
    const unavailable = await exported([makeSpan('b')], 503);

    expect((refused.exporter as unknown as { pendingSpans: unknown[] }).pendingSpans).toHaveLength(
      0
    );
    expect(
      (unavailable.exporter as unknown as { pendingSpans: unknown[] }).pendingSpans
    ).toHaveLength(1);
    error.mockRestore();
  });

  it('starts flush interval only once', () => {
    vi.useFakeTimers();

    const exporter = new OTLPExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      enabled: true,
    });

    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    exporter.start();
    exporter.start();
    exporter.stop();

    expect(intervalSpy).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caps pending spans at MAX_PENDING_SPANS on failed flush pushback', async () => {
    const exporter = new OTLPExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      enabled: true,
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    exporter.onRunStart({
      runId: 'run-1',
      agentId: 'agent-1',
      agentName: 'Test',
      input: 'test',
    });

    for (let i = 0; i < 10_050; i++) {
      exporter.exportSpan('run-1', makeSpan(`span-${i}`));
    }

    await exporter.flush();

    for (let i = 0; i < 100; i++) {
      exporter.exportSpan('run-1', makeSpan(`extra-${i}`));
    }

    await exporter.flush();

    const pendingField = (exporter as unknown as { pendingSpans: unknown[] }).pendingSpans;
    expect(pendingField.length).toBeLessThanOrEqual(10_000);

    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('drops oldest spans when pushback exceeds limit', async () => {
    const exporter = new OTLPExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      enabled: true,
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    exporter.onRunStart({
      runId: 'run-1',
      agentId: 'agent-1',
      agentName: 'Test',
      input: 'test',
    });

    for (let i = 0; i < 9_990; i++) {
      exporter.exportSpan('run-1', makeSpan(`pre-${i}`));
    }

    await exporter.flush();

    const pendingField = (exporter as unknown as { pendingSpans: unknown[] }).pendingSpans;

    expect(pendingField.length).toBeLessThanOrEqual(10_000);

    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('does not lose spans when within limit on pushback', async () => {
    const exporter = new OTLPExporter({
      endpoint: 'http://localhost:4318/v1/traces',
      enabled: true,
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    exporter.onRunStart({
      runId: 'run-1',
      agentId: 'agent-1',
      agentName: 'Test',
      input: 'test',
    });

    for (let i = 0; i < 50; i++) {
      exporter.exportSpan('run-1', makeSpan(`span-${i}`));
    }

    await exporter.flush();

    const pendingField = (exporter as unknown as { pendingSpans: unknown[] }).pendingSpans;
    expect(pendingField.length).toBe(50);

    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
