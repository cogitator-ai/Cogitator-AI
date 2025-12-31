/**
 * Span exporters for workflow tracing
 *
 * Supports:
 * - Console (for development/debugging)
 * - OTLP HTTP (OpenTelemetry Protocol)
 * - Jaeger (via OTLP or native)
 * - Zipkin
 */

import type { WorkflowSpan, SpanExporter } from '@cogitator-ai/types';

export interface SpanExporterInstance {
  export(spans: WorkflowSpan[]): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ExporterConfig {
  type: SpanExporter;
  endpoint?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushInterval?: number;
}

/**
 * Console exporter for development/debugging
 */
export class ConsoleSpanExporter implements SpanExporterInstance {
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  async export(spans: WorkflowSpan[]): Promise<void> {
    for (const span of spans) {
      const duration = span.endTime
        ? `${(span.endTime - span.startTime).toString()}ms`
        : 'ongoing';

      const statusIcon =
        span.status === 'ok' ? '✓' : span.status === 'error' ? '✗' : '○';
      const indent = span.parentSpanId ? '  └─' : '';

      console.log(
        `${indent}[${span.traceId.slice(0, 8)}] ${statusIcon} ${span.name} (${duration})`
      );

      if (this.verbose) {
        console.log('  Attributes:', JSON.stringify(span.attributes, null, 2));
        if (span.events.length > 0) {
          console.log('  Events:', span.events.map((e) => e.name).join(', '));
        }
        if (span.statusMessage) {
          console.log('  Message:', span.statusMessage);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
  }
}

/**
 * OTLP HTTP exporter for OpenTelemetry-compatible backends
 * (Jaeger, Tempo, Honeycomb, Datadog, etc.)
 */
export class OTLPSpanExporter implements SpanExporterInstance {
  private endpoint: string;
  private headers: Record<string, string>;
  private batchSize: number;
  private flushInterval: number;
  private pendingSpans: WorkflowSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: {
    endpoint?: string;
    headers?: Record<string, string>;
    batchSize?: number;
    flushInterval?: number;
  }) {
    this.endpoint =
      config.endpoint ?? 'http://localhost:4318/v1/traces';
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
    this.batchSize = config.batchSize ?? 512;
    this.flushInterval = config.flushInterval ?? 5000;

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushInterval);
  }

  async export(spans: WorkflowSpan[]): Promise<void> {
    this.pendingSpans.push(...spans);

    if (this.pendingSpans.length >= this.batchSize) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.pendingSpans.length === 0) return;

    const spansToExport = this.pendingSpans.splice(0, this.batchSize);
    const payload = this.toOTLPFormat(spansToExport);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(
          `OTLP export failed: ${response.status.toString()} ${response.statusText}`
        );
        this.pendingSpans.unshift(...spansToExport);
      }
    } catch (error) {
      console.error('OTLP export error:', error);
      this.pendingSpans.unshift(...spansToExport);
    }
  }

  private toOTLPFormat(spans: WorkflowSpan[]): OTLPTraceData {
    const resourceSpans: OTLPResourceSpan[] = [
      {
        resource: {
          attributes: [],
        },
        scopeSpans: [
          {
            scope: {
              name: '@cogitator-ai/workflows',
              version: '1.0.0',
            },
            spans: spans.map((span) => this.spanToOTLP(span)),
          },
        ],
      },
    ];

    return { resourceSpans };
  }

  private spanToOTLP(span: WorkflowSpan): OTLPSpan {
    const statusCode =
      span.status === 'ok' ? 1 : span.status === 'error' ? 2 : 0;

    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: this.kindToOTLP(span.kind),
      startTimeUnixNano: (span.startTime * 1_000_000).toString(),
      endTimeUnixNano: span.endTime
        ? (span.endTime * 1_000_000).toString()
        : undefined,
      attributes: Object.entries(span.attributes).map(([key, value]) => ({
        key,
        value: this.valueToOTLP(value),
      })),
      events: span.events.map((event) => ({
        name: event.name,
        timeUnixNano: (event.timestamp * 1_000_000).toString(),
        attributes: event.attributes
          ? Object.entries(event.attributes).map(([key, value]) => ({
              key,
              value: this.valueToOTLP(value),
            }))
          : [],
      })),
      links: span.links.map((link) => ({
        traceId: link.traceId,
        spanId: link.spanId,
        attributes: link.attributes
          ? Object.entries(link.attributes).map(([key, value]) => ({
              key,
              value: this.valueToOTLP(value),
            }))
          : [],
      })),
      status: {
        code: statusCode,
        message: span.statusMessage,
      },
    };
  }

  private kindToOTLP(kind: string): number {
    const kindMap: Record<string, number> = {
      internal: 1,
      server: 2,
      client: 3,
      producer: 4,
      consumer: 5,
    };
    return kindMap[kind] ?? 0;
  }

  private valueToOTLP(value: unknown): OTLPValue {
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { intValue: value.toString() };
      }
      return { doubleValue: value };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.valueToOTLP(v)),
        },
      };
    }
    return { stringValue: JSON.stringify(value) };
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/**
 * Zipkin exporter
 */
export class ZipkinSpanExporter implements SpanExporterInstance {
  private endpoint: string;
  private headers: Record<string, string>;
  private serviceName: string;

  constructor(config: {
    endpoint?: string;
    headers?: Record<string, string>;
    serviceName?: string;
  }) {
    this.endpoint =
      config.endpoint ?? 'http://localhost:9411/api/v2/spans';
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
    this.serviceName = config.serviceName ?? 'cogitator-workflow';
  }

  async export(spans: WorkflowSpan[]): Promise<void> {
    const zipkinSpans = spans.map((span) => this.toZipkinFormat(span));

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(zipkinSpans),
      });

      if (!response.ok) {
        console.error(
          `Zipkin export failed: ${response.status.toString()} ${response.statusText}`
        );
      }
    } catch (error) {
      console.error('Zipkin export error:', error);
    }
  }

  private toZipkinFormat(span: WorkflowSpan): ZipkinSpan {
    const kind = this.kindToZipkin(span.kind);

    const result: ZipkinSpan = {
      traceId: span.traceId,
      id: span.spanId,
      name: span.name,
      timestamp: span.startTime * 1000,
      duration: span.endTime
        ? (span.endTime - span.startTime) * 1000
        : undefined,
      localEndpoint: {
        serviceName: this.serviceName,
      },
      tags: {},
      annotations: [],
    };

    if (span.parentSpanId) {
      result.parentId = span.parentSpanId;
    }

    if (kind) {
      result.kind = kind;
    }

    for (const [key, value] of Object.entries(span.attributes)) {
      result.tags[key] = String(value);
    }

    if (span.status === 'error') {
      result.tags.error = 'true';
      if (span.statusMessage) {
        result.tags['error.message'] = span.statusMessage;
      }
    }

    for (const event of span.events) {
      result.annotations.push({
        timestamp: event.timestamp * 1000,
        value: event.name,
      });
    }

    return result;
  }

  private kindToZipkin(
    kind: string
  ): 'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER' | undefined {
    const kindMap: Record<
      string,
      'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER' | undefined
    > = {
      client: 'CLIENT',
      server: 'SERVER',
      producer: 'PRODUCER',
      consumer: 'CONSUMER',
      internal: undefined,
    };
    return kindMap[kind];
  }

  async shutdown(): Promise<void> {
  }
}

/**
 * Composite exporter that sends to multiple backends
 */
export class CompositeSpanExporter implements SpanExporterInstance {
  private exporters: SpanExporterInstance[];

  constructor(exporters: SpanExporterInstance[]) {
    this.exporters = exporters;
  }

  async export(spans: WorkflowSpan[]): Promise<void> {
    await Promise.allSettled(
      this.exporters.map((exporter) => exporter.export(spans))
    );
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      this.exporters.map((exporter) => exporter.shutdown())
    );
  }
}

/**
 * No-op exporter for when tracing is disabled
 */
export class NoopSpanExporter implements SpanExporterInstance {
  async export(): Promise<void> {
  }

  async shutdown(): Promise<void> {
  }
}

/**
 * Factory function to create an exporter from config
 */
export function createSpanExporter(config: ExporterConfig): SpanExporterInstance {
  switch (config.type) {
    case 'console':
      return new ConsoleSpanExporter(true);

    case 'otlp':
      return new OTLPSpanExporter({
        endpoint: config.endpoint,
        headers: config.headers,
        batchSize: config.batchSize,
        flushInterval: config.flushInterval,
      });

    case 'jaeger':
      return new OTLPSpanExporter({
        endpoint: config.endpoint ?? 'http://localhost:4318/v1/traces',
        headers: config.headers,
        batchSize: config.batchSize,
        flushInterval: config.flushInterval,
      });

    case 'zipkin':
      return new ZipkinSpanExporter({
        endpoint: config.endpoint,
        headers: config.headers,
      });

    default:
      return new NoopSpanExporter();
  }
}

interface OTLPTraceData {
  resourceSpans: OTLPResourceSpan[];
}

interface OTLPResourceSpan {
  resource: {
    attributes: OTLPAttribute[];
  };
  scopeSpans: OTLPScopeSpan[];
}

interface OTLPScopeSpan {
  scope: {
    name: string;
    version: string;
  };
  spans: OTLPSpan[];
}

interface OTLPSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: OTLPAttribute[];
  events: OTLPEvent[];
  links: OTLPLink[];
  status: {
    code: number;
    message?: string;
  };
}

interface OTLPAttribute {
  key: string;
  value: OTLPValue;
}

interface OTLPValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OTLPValue[] };
}

interface OTLPEvent {
  name: string;
  timeUnixNano: string;
  attributes: OTLPAttribute[];
}

interface OTLPLink {
  traceId: string;
  spanId: string;
  attributes: OTLPAttribute[];
}

interface ZipkinSpan {
  traceId: string;
  id: string;
  parentId?: string;
  name: string;
  kind?: 'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER';
  timestamp: number;
  duration?: number;
  localEndpoint: {
    serviceName: string;
  };
  tags: Record<string, string>;
  annotations: {
    timestamp: number;
    value: string;
  }[];
}
