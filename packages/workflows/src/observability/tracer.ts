import type {
  TracingConfig,
  WorkflowSpan,
  SpanKind,
  SpanStatus,
  SpanLink,
  TraceContext,
  Baggage,
} from '@cogitator-ai/types';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { type SpanExporterInstance, createSpanExporter, NoopSpanExporter } from './exporters';
import {
  TRACE_PARENT_HEADER,
  TRACE_STATE_HEADER,
  BAGGAGE_HEADER,
  WORKFLOW_NAME,
  WORKFLOW_ID,
  WORKFLOW_RUN_ID,
  SERVICE_NAME,
  SERVICE_VERSION,
} from './span-attributes';

const TRACE_VERSION = '00';
const DEFAULT_SAMPLE_RATE = 1.0;
const HEX_RE = /^[0-9a-f]+$/;

function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

function parseTraceParent(header: string): TraceContext | null {
  const parts = header.split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, spanId, flags] = parts;

  if (version === 'ff') return null;
  if (version.length !== 2 || !HEX_RE.test(version)) return null;
  if (traceId.length !== 32 || !HEX_RE.test(traceId) || /^0+$/.test(traceId)) return null;
  if (spanId.length !== 16 || !HEX_RE.test(spanId) || /^0+$/.test(spanId)) return null;

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
  };
}

function formatTraceParent(ctx: TraceContext): string {
  const flags = (ctx.traceFlags ?? 1).toString(16).padStart(2, '0');
  return `${TRACE_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

function parseBaggage(header: string): Baggage {
  const baggage: Baggage = {};
  const pairs = header.split(',');

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key && value) {
      baggage[key] = decodeURIComponent(value);
    }
  }

  return baggage;
}

function formatBaggage(baggage: Baggage): string {
  return Object.entries(baggage)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
}

export interface SpanScope {
  span: WorkflowSpan;
  end: (status?: SpanStatus, message?: string) => void;
  addEvent: (name: string, attributes?: Record<string, unknown>) => void;
  setAttribute: (key: string, value: unknown) => void;
  setAttributes: (attributes: Record<string, unknown>) => void;
  recordException: (error: Error) => void;
}

interface AsyncSpanContext {
  spanStack: WorkflowSpan[];
}

export class WorkflowTracer {
  private config: TracingConfig;
  private exporter: SpanExporterInstance;
  private completedSpans: WorkflowSpan[] = [];
  private currentTraceContext: TraceContext | null = null;
  private baggage: Baggage = {};
  private sampleRate: number;
  private asyncLocalStorage = new AsyncLocalStorage<AsyncSpanContext>();
  private rootSpanStack: WorkflowSpan[] = [];

  constructor(config: Partial<TracingConfig> = {}) {
    this.config = {
      enabled: true,
      serviceName: 'cogitator-workflow',
      serviceVersion: '1.0.0',
      sampleRate: DEFAULT_SAMPLE_RATE,
      propagateContext: true,
      exporter: 'console',
      ...config,
    };

    this.sampleRate = this.config.sampleRate ?? 1.0;

    if (!this.config.enabled) {
      this.exporter = new NoopSpanExporter();
      return;
    }

    this.exporter = createSpanExporter({
      type: this.config.exporter ?? 'console',
      endpoint: this.config.exporterEndpoint,
      headers: this.config.exporterHeaders,
      batchSize: this.config.batchSize,
      flushInterval: this.config.flushInterval,
    });
  }

  isSampled(): boolean {
    return this.config.enabled;
  }

  private getSpanStack(): WorkflowSpan[] {
    const ctx = this.asyncLocalStorage.getStore();
    if (ctx) return ctx.spanStack;
    return this.rootSpanStack;
  }

  setContextFromHeaders(headers: Record<string, string>): void {
    const traceparent = headers[TRACE_PARENT_HEADER];
    if (traceparent) {
      this.currentTraceContext = parseTraceParent(traceparent);
    }

    const tracestate = headers[TRACE_STATE_HEADER];
    if (tracestate && this.currentTraceContext) {
      this.currentTraceContext.traceState = tracestate;
    }

    const baggageHeader = headers[BAGGAGE_HEADER];
    if (baggageHeader) {
      this.baggage = { ...this.baggage, ...parseBaggage(baggageHeader) };
    }
  }

  getContextHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.currentTraceContext && this.config.propagateContext) {
      headers[TRACE_PARENT_HEADER] = formatTraceParent(this.currentTraceContext);

      if (this.currentTraceContext.traceState) {
        headers[TRACE_STATE_HEADER] = this.currentTraceContext.traceState;
      }
    }

    if (Object.keys(this.baggage).length > 0) {
      headers[BAGGAGE_HEADER] = formatBaggage(this.baggage);
    }

    return headers;
  }

  setBaggage(key: string, value: string): void {
    this.baggage[key] = value;
  }

  getBaggage(key: string): string | undefined {
    return this.baggage[key];
  }

  getTraceContext(): TraceContext | null {
    return this.currentTraceContext;
  }

  startWorkflowSpan(
    workflowName: string,
    workflowId: string,
    runId: string,
    attributes?: Record<string, unknown>
  ): SpanScope {
    const sampled = Math.random() < this.sampleRate;
    const traceId = this.currentTraceContext?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const parentSpanId = this.currentTraceContext?.spanId;

    const span: WorkflowSpan = {
      traceId,
      spanId,
      parentSpanId,
      name: `workflow:${workflowName}`,
      kind: 'internal',
      startTime: Date.now(),
      attributes: {
        [SERVICE_NAME]: this.config.serviceName,
        [SERVICE_VERSION]: this.config.serviceVersion,
        [WORKFLOW_NAME]: workflowName,
        [WORKFLOW_ID]: workflowId,
        [WORKFLOW_RUN_ID]: runId,
        ...this.config.attributes,
        ...attributes,
      },
      events: [],
      links: [],
      status: 'unset',
    };

    this.currentTraceContext = {
      traceId,
      spanId,
      traceFlags: sampled ? 1 : 0,
    };

    const spanStack = this.getSpanStack();
    spanStack.push(span);

    return this.createSpanScope(span, sampled);
  }

  startNodeSpan(
    nodeName: string,
    nodeType: string,
    attributes?: Record<string, unknown>
  ): SpanScope {
    const spanStack = this.getSpanStack();
    const parentSpan = spanStack[spanStack.length - 1];
    const traceId = parentSpan?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const sampled = this.currentTraceContext
      ? (this.currentTraceContext.traceFlags ?? 0) & 1
      : true;

    const span: WorkflowSpan = {
      traceId,
      spanId,
      parentSpanId: parentSpan?.spanId,
      name: `node:${nodeName}`,
      kind: 'internal',
      startTime: Date.now(),
      attributes: {
        'node.name': nodeName,
        'node.type': nodeType,
        ...attributes,
      },
      events: [],
      links: [],
      status: 'unset',
    };

    this.currentTraceContext = {
      traceId,
      spanId,
      traceFlags: sampled ? 1 : 0,
    };

    spanStack.push(span);

    return this.createSpanScope(span, Boolean(sampled));
  }

  startToolSpan(toolName: string, attributes?: Record<string, unknown>): SpanScope {
    const spanStack = this.getSpanStack();
    const parentSpan = spanStack[spanStack.length - 1];
    const traceId = parentSpan?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const sampled = this.currentTraceContext
      ? (this.currentTraceContext.traceFlags ?? 0) & 1
      : true;

    const span: WorkflowSpan = {
      traceId,
      spanId,
      parentSpanId: parentSpan?.spanId,
      name: `tool:${toolName}`,
      kind: 'client',
      startTime: Date.now(),
      attributes: {
        'tool.name': toolName,
        ...attributes,
      },
      events: [],
      links: [],
      status: 'unset',
    };

    this.currentTraceContext = {
      traceId,
      spanId,
      traceFlags: sampled ? 1 : 0,
    };

    spanStack.push(span);

    return this.createSpanScope(span, Boolean(sampled));
  }

  startSpan(
    name: string,
    kind: SpanKind = 'internal',
    attributes?: Record<string, unknown>
  ): SpanScope {
    const spanStack = this.getSpanStack();
    const parentSpan = spanStack[spanStack.length - 1];
    const traceId = parentSpan?.traceId ?? generateTraceId();
    const spanId = generateSpanId();
    const sampled = this.currentTraceContext
      ? (this.currentTraceContext.traceFlags ?? 0) & 1
      : true;

    const span: WorkflowSpan = {
      traceId,
      spanId,
      parentSpanId: parentSpan?.spanId,
      name,
      kind,
      startTime: Date.now(),
      attributes: { ...attributes },
      events: [],
      links: [],
      status: 'unset',
    };

    spanStack.push(span);

    return this.createSpanScope(span, Boolean(sampled));
  }

  /**
   * Run a function within an isolated async span context.
   * Concurrent branches each get their own span stack, preventing
   * parent-child corruption in parallel DAG nodes.
   */
  runInContext<T>(fn: () => T): T {
    const parentCtx = this.asyncLocalStorage.getStore();
    const newCtx: AsyncSpanContext = {
      spanStack: parentCtx ? [...parentCtx.spanStack] : [...this.rootSpanStack],
    };
    return this.asyncLocalStorage.run(newCtx, fn);
  }

  private createSpanScope(span: WorkflowSpan, sampled: boolean): SpanScope {
    return {
      span,

      end: (status: SpanStatus = 'ok', message?: string) => {
        span.endTime = Date.now();
        span.status = status;
        if (message) {
          span.statusMessage = message;
        }

        const spanStack = this.getSpanStack();
        const idx = spanStack.indexOf(span);
        if (idx !== -1) {
          spanStack.splice(idx, 1);
        }

        const parentSpan = spanStack[spanStack.length - 1];
        if (parentSpan) {
          this.currentTraceContext = {
            traceId: parentSpan.traceId,
            spanId: parentSpan.spanId,
            traceFlags: sampled ? 1 : 0,
          };
        }

        if (sampled) {
          this.completedSpans.push(span);
        }
      },

      addEvent: (name: string, attributes?: Record<string, unknown>) => {
        span.events.push({
          name,
          timestamp: Date.now(),
          attributes,
        });
      },

      setAttribute: (key: string, value: unknown) => {
        span.attributes[key] = value;
      },

      setAttributes: (attributes: Record<string, unknown>) => {
        Object.assign(span.attributes, attributes);
      },

      recordException: (error: Error) => {
        span.events.push({
          name: 'exception',
          timestamp: Date.now(),
          attributes: {
            'exception.type': error.name,
            'exception.message': error.message,
            'exception.stacktrace': error.stack,
          },
        });
        span.status = 'error';
        span.statusMessage = error.message;
      },
    };
  }

  addLink(span: WorkflowSpan, link: SpanLink): void {
    span.links.push(link);
  }

  getCurrentSpan(): WorkflowSpan | undefined {
    const spanStack = this.getSpanStack();
    return spanStack[spanStack.length - 1];
  }

  async flush(): Promise<void> {
    if (this.completedSpans.length === 0) {
      return;
    }

    const spansToExport = [...this.completedSpans];
    this.completedSpans = [];

    await this.exporter.export(spansToExport);
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await this.exporter.shutdown();
  }

  async trace<T>(
    name: string,
    fn: (scope: SpanScope) => Promise<T>,
    options?: {
      kind?: SpanKind;
      attributes?: Record<string, unknown>;
    }
  ): Promise<T> {
    const scope = this.startSpan(name, options?.kind, options?.attributes);

    try {
      const result = await fn(scope);
      scope.end('ok');
      return result;
    } catch (error) {
      scope.recordException(error as Error);
      scope.end('error', (error as Error).message);
      throw error;
    }
  }
}

export function createTracer(config?: Partial<TracingConfig>): WorkflowTracer {
  return new WorkflowTracer(config);
}

let globalTracer: WorkflowTracer | null = null;

export function getGlobalTracer(): WorkflowTracer {
  if (!globalTracer) {
    globalTracer = new WorkflowTracer({ enabled: false });
  }
  return globalTracer;
}

export function setGlobalTracer(tracer: WorkflowTracer): void {
  globalTracer = tracer;
}
