/**
 * WorkflowTracer - Distributed tracing for workflow execution
 *
 * Features:
 * - W3C Trace Context propagation
 * - Hierarchical span creation (workflow → node → tool)
 * - Automatic span lifecycle management
 * - Context-aware span attributes
 * - Multi-backend export support
 */

import type {
  TracingConfig,
  WorkflowSpan,
  SpanKind,
  SpanStatus,
  SpanLink,
  TraceContext,
  Baggage,
} from '@cogitator/types';
import { nanoid } from 'nanoid';
import {
  type SpanExporterInstance,
  createSpanExporter,
  NoopSpanExporter,
} from './exporters.js';
import {
  TRACE_PARENT_HEADER,
  TRACE_STATE_HEADER,
  BAGGAGE_HEADER,
  WORKFLOW_NAME,
  WORKFLOW_ID,
  WORKFLOW_RUN_ID,
  SERVICE_NAME,
  SERVICE_VERSION,
} from './span-attributes.js';

const TRACE_VERSION = '00';
const DEFAULT_SAMPLE_RATE = 1.0;

/**
 * Generate a random trace ID (32 hex chars)
 */
function generateTraceId(): string {
  return nanoid(16)
    .split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Generate a random span ID (16 hex chars)
 */
function generateSpanId(): string {
  return nanoid(8)
    .split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * Parse W3C traceparent header
 * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
 */
function parseTraceParent(header: string): TraceContext | null {
  const parts = header.split('-');
  if (parts.length !== 4) return null;

  const [version, traceId, spanId, flags] = parts;
  if (version !== TRACE_VERSION) return null;
  if (traceId.length !== 32 || spanId.length !== 16) return null;

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
  };
}

/**
 * Format TraceContext to W3C traceparent header
 */
function formatTraceParent(ctx: TraceContext): string {
  const flags = (ctx.traceFlags ?? 1).toString(16).padStart(2, '0');
  return `${TRACE_VERSION}-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Parse W3C baggage header
 * Format: key1=value1,key2=value2
 */
function parseBaggage(header: string): Baggage {
  const baggage: Baggage = {};
  const pairs = header.split(',');

  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key && value) {
      baggage[key.trim()] = decodeURIComponent(value.trim());
    }
  }

  return baggage;
}

/**
 * Format Baggage to W3C baggage header
 */
function formatBaggage(baggage: Baggage): string {
  return Object.entries(baggage)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(',');
}

/**
 * Active span context for scoped operations
 */
interface SpanScope {
  span: WorkflowSpan;
  end: (status?: SpanStatus, message?: string) => void;
  addEvent: (name: string, attributes?: Record<string, unknown>) => void;
  setAttribute: (key: string, value: unknown) => void;
  setAttributes: (attributes: Record<string, unknown>) => void;
  recordException: (error: Error) => void;
}

/**
 * WorkflowTracer - Main tracing class
 */
export class WorkflowTracer {
  private config: TracingConfig;
  private exporter: SpanExporterInstance;
  private spanStack: WorkflowSpan[] = [];
  private completedSpans: WorkflowSpan[] = [];
  private currentTraceContext: TraceContext | null = null;
  private baggage: Baggage = {};
  private sampleDecision: boolean = true;

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

    // Make sample decision once per tracer
    this.sampleDecision = Math.random() < (this.config.sampleRate ?? 1.0);
  }

  /**
   * Check if this tracer is sampling
   */
  isSampled(): boolean {
    return this.config.enabled && this.sampleDecision;
  }

  /**
   * Set trace context from incoming request headers
   */
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

  /**
   * Get headers for outgoing request context propagation
   */
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

  /**
   * Set a baggage value
   */
  setBaggage(key: string, value: string): void {
    this.baggage[key] = value;
  }

  /**
   * Get a baggage value
   */
  getBaggage(key: string): string | undefined {
    return this.baggage[key];
  }

  /**
   * Get current trace context
   */
  getTraceContext(): TraceContext | null {
    return this.currentTraceContext;
  }

  /**
   * Start a new workflow trace
   */
  startWorkflowSpan(
    workflowName: string,
    workflowId: string,
    runId: string,
    attributes?: Record<string, unknown>
  ): SpanScope {
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

    // Update trace context
    this.currentTraceContext = {
      traceId,
      spanId,
      traceFlags: 1,
    };

    this.spanStack.push(span);

    return this.createSpanScope(span);
  }

  /**
   * Start a node execution span
   */
  startNodeSpan(
    nodeName: string,
    nodeType: string,
    attributes?: Record<string, unknown>
  ): SpanScope {
    const parentSpan = this.spanStack[this.spanStack.length - 1];
    const traceId = parentSpan?.traceId ?? generateTraceId();
    const spanId = generateSpanId();

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

    // Update context for child spans
    this.currentTraceContext = {
      traceId,
      spanId,
      traceFlags: 1,
    };

    this.spanStack.push(span);

    return this.createSpanScope(span);
  }

  /**
   * Start a tool execution span
   */
  startToolSpan(
    toolName: string,
    attributes?: Record<string, unknown>
  ): SpanScope {
    const parentSpan = this.spanStack[this.spanStack.length - 1];
    const traceId = parentSpan?.traceId ?? generateTraceId();
    const spanId = generateSpanId();

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

    this.spanStack.push(span);

    return this.createSpanScope(span);
  }

  /**
   * Start a custom span
   */
  startSpan(
    name: string,
    kind: SpanKind = 'internal',
    attributes?: Record<string, unknown>
  ): SpanScope {
    const parentSpan = this.spanStack[this.spanStack.length - 1];
    const traceId = parentSpan?.traceId ?? generateTraceId();
    const spanId = generateSpanId();

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

    this.spanStack.push(span);

    return this.createSpanScope(span);
  }

  /**
   * Create a span scope with lifecycle methods
   */
  private createSpanScope(span: WorkflowSpan): SpanScope {
    return {
      span,

      end: (status: SpanStatus = 'ok', message?: string) => {
        span.endTime = Date.now();
        span.status = status;
        if (message) {
          span.statusMessage = message;
        }

        // Remove from stack
        const idx = this.spanStack.indexOf(span);
        if (idx !== -1) {
          this.spanStack.splice(idx, 1);
        }

        // Restore parent context
        const parentSpan = this.spanStack[this.spanStack.length - 1];
        if (parentSpan) {
          this.currentTraceContext = {
            traceId: parentSpan.traceId,
            spanId: parentSpan.spanId,
            traceFlags: 1,
          };
        }

        // Add to completed spans
        this.completedSpans.push(span);
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

  /**
   * Add a link between spans
   */
  addLink(span: WorkflowSpan, link: SpanLink): void {
    span.links.push(link);
  }

  /**
   * Get current active span
   */
  getCurrentSpan(): WorkflowSpan | undefined {
    return this.spanStack[this.spanStack.length - 1];
  }

  /**
   * Flush completed spans to exporter
   */
  async flush(): Promise<void> {
    if (!this.isSampled() || this.completedSpans.length === 0) {
      return;
    }

    const spansToExport = [...this.completedSpans];
    this.completedSpans = [];

    await this.exporter.export(spansToExport);
  }

  /**
   * Shutdown tracer and flush remaining spans
   */
  async shutdown(): Promise<void> {
    await this.flush();
    await this.exporter.shutdown();
  }

  /**
   * Run a function with automatic span creation
   */
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

/**
 * Create a tracer instance
 */
export function createTracer(config?: Partial<TracingConfig>): WorkflowTracer {
  return new WorkflowTracer(config);
}

/**
 * Global tracer instance for convenience
 */
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
