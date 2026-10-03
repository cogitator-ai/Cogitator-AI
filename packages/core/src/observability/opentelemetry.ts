import { createHash } from 'node:crypto';
import type { Span as CogitatorSpan, RunResult } from '@cogitator-ai/types';

export interface OTLPExporterConfig {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName?: string;
  serviceVersion?: string;
  enabled?: boolean;
}

interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: OTLPAnyValue }>;
  status: { code: number; message?: string };
}

interface ResourceSpans {
  resource: {
    attributes: Array<{ key: string; value: { stringValue: string } }>;
  };
  scopeSpans: Array<{
    scope: { name: string; version?: string };
    spans: OTLPSpan[];
  }>;
}

const SPAN_KIND = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

const STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

type OTLPAnyValue =
  { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

const MAX_PENDING_SPANS = 10_000;
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const NANOS_PER_MILLI = 1_000_000n;

/**
 * An OTLP id for a Cogitator id: kept when it already is lowercase hex of the
 * right length, otherwise the first bytes of its SHA-256. Deriving rather than
 * generating keeps parent links intact and needs no state per run.
 */
function toOtlpId(id: string, bytes: number): string {
  const hexLength = bytes * 2;
  if (id.length === hexLength && /^[0-9a-f]+$/.test(id) && !/^0+$/.test(id)) return id;
  return createHash('sha256').update(id).digest('hex').slice(0, hexLength);
}

function toAnyValue(value: unknown): OTLPAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  return { stringValue: JSON.stringify(value) ?? String(value) };
}

function toUnixNano(milliseconds: number): string {
  return (BigInt(Math.round(milliseconds)) * NANOS_PER_MILLI).toString();
}

export class OTLPExporter {
  private config: OTLPExporterConfig;
  private pendingSpans: OTLPSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OTLPExporterConfig) {
    this.config = {
      serviceName: 'cogitator',
      serviceVersion: '1.0.0',
      ...config,
    };
  }

  start(): void {
    if (!this.config.enabled) return;
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 5000);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Run lifecycle hooks. OTLP ids derive from the ids on each span, so a run
   * needs no setup or cleanup here; the hooks stay so callers can wire every
   * Cogitator callback the same way.
   */
  onRunStart(_options: {
    runId: string;
    agentId: string;
    agentName: string;
    input: string;
  }): void {}

  onRunComplete(_result: RunResult): void {}

  onRunError(_error: Error, _runId: string): void {}

  /**
   * Queues a span for export. `runId` is recorded as the `cogitator.run_id`
   * attribute; the trace comes from `span.traceId`.
   */
  exportSpan(runId: string, span: CogitatorSpan): void {
    if (!this.config.enabled) return;

    const kind = {
      internal: SPAN_KIND.INTERNAL,
      client: SPAN_KIND.CLIENT,
      server: SPAN_KIND.SERVER,
      producer: SPAN_KIND.PRODUCER,
      consumer: SPAN_KIND.CONSUMER,
    }[span.kind];

    const status = {
      ok: STATUS_CODE.OK,
      error: STATUS_CODE.ERROR,
      unset: STATUS_CODE.UNSET,
    }[span.status];

    const attributes = [
      ...Object.entries(span.attributes)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => ({ key, value: toAnyValue(value) })),
      { key: 'cogitator.run_id', value: { stringValue: runId } },
      { key: 'cogitator.trace_id', value: { stringValue: span.traceId } },
      { key: 'cogitator.span_id', value: { stringValue: span.id } },
    ];

    const otlpSpan: OTLPSpan = {
      traceId: toOtlpId(span.traceId, TRACE_ID_BYTES),
      spanId: toOtlpId(span.id, SPAN_ID_BYTES),
      ...(span.parentId && { parentSpanId: toOtlpId(span.parentId, SPAN_ID_BYTES) }),
      name: span.name,
      kind,
      startTimeUnixNano: toUnixNano(span.startTime),
      endTimeUnixNano: toUnixNano(span.endTime),
      attributes,
      status: { code: status },
    };

    this.pendingSpans.push(otlpSpan);

    if (this.pendingSpans.length >= 100) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.pendingSpans.length === 0) return;

    const spans = this.pendingSpans.splice(0, this.pendingSpans.length);

    const resourceSpans: ResourceSpans = {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: this.config.serviceName! } },
          { key: 'service.version', value: { stringValue: this.config.serviceVersion! } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: 'cogitator', version: '1.0.0' },
          spans,
        },
      ],
    };

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify({ resourceSpans: [resourceSpans] }),
      });

      if (!response.ok) {
        const retryable =
          response.status >= 500 || response.status === 408 || response.status === 429;
        console.error(
          `OTLP export failed: ${response.status} ${response.statusText}` +
            (retryable ? '' : ` (dropping ${spans.length} spans the collector refused)`)
        );
        if (retryable) this.pushBackSpans(spans);
      }
    } catch (err) {
      console.error('OTLP export error:', err);
      this.pushBackSpans(spans);
    }
  }

  private pushBackSpans(spans: OTLPSpan[]): void {
    const total = this.pendingSpans.length + spans.length;
    if (total > MAX_PENDING_SPANS) {
      const toDrop = total - MAX_PENDING_SPANS;
      if (toDrop >= spans.length) {
        return;
      }
      this.pendingSpans.push(...spans.slice(toDrop));
    } else {
      this.pendingSpans.push(...spans);
    }
  }
}

export function createOTLPExporter(config: OTLPExporterConfig): OTLPExporter {
  return new OTLPExporter(config);
}
