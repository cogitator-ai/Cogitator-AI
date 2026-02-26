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
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
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

const MAX_PENDING_SPANS = 10_000;

export class OTLPExporter {
  private config: OTLPExporterConfig;
  private pendingSpans: OTLPSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private traceIds = new Map<string, string>();

  constructor(config: OTLPExporterConfig) {
    this.config = {
      serviceName: 'cogitator',
      serviceVersion: '1.0.0',
      ...config,
    };
  }

  start(): void {
    if (!this.config.enabled) return;

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

  onRunStart(options: { runId: string; agentId: string; agentName: string; input: string }): void {
    if (!this.config.enabled) return;

    const traceId = this.generateTraceId();
    this.traceIds.set(options.runId, traceId);
  }

  onRunComplete(result: RunResult): void {
    this.traceIds.delete(result.runId);
  }

  exportSpan(runId: string, span: CogitatorSpan): void {
    if (!this.config.enabled) return;

    const traceId = this.traceIds.get(runId) ?? span.traceId;

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

    const attributes = Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value:
        typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) },
    }));

    const otlpSpan: OTLPSpan = {
      traceId,
      spanId: span.id,
      parentSpanId: span.parentId,
      name: span.name,
      kind,
      startTimeUnixNano: String(span.startTime * 1_000_000),
      endTimeUnixNano: String(span.endTime * 1_000_000),
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
        console.error(`OTLP export failed: ${response.status} ${response.statusText}`);
        this.pushBackSpans(spans);
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

  private generateTraceId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

export function createOTLPExporter(config: OTLPExporterConfig): OTLPExporter {
  return new OTLPExporter(config);
}
