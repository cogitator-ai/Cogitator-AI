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
