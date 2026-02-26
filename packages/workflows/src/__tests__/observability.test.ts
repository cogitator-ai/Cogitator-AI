import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkflowTracer,
  createTracer,
  getGlobalTracer,
  setGlobalTracer,
  WorkflowMetricsCollector,
  createMetricsCollector,
  getGlobalMetrics,
  setGlobalMetrics,
  ConsoleSpanExporter,
  OTLPSpanExporter,
  CompositeSpanExporter,
  NoopSpanExporter,
  createSpanExporter,
} from '../index';
import {
  WORKFLOW_NAME,
  WORKFLOW_ID,
  WORKFLOW_RUN_ID,
  SERVICE_NAME,
  SERVICE_VERSION,
  workflowSpanAttributes,
  nodeSpanAttributes,
  llmSpanAttributes,
  toolSpanAttributes,
  errorSpanAttributes,
  retrySpanAttributes,
} from '../observability/span-attributes';

describe('WorkflowTracer', () => {
  let tracer: WorkflowTracer;

  beforeEach(() => {
    tracer = new WorkflowTracer({ enabled: true, exporter: 'noop' });
  });

  describe('createSpan / startSpan', () => {
    it('creates a custom span with default kind', () => {
      const scope = tracer.startSpan('test-span');
      expect(scope.span).toBeDefined();
      expect(scope.span.name).toBe('test-span');
      expect(scope.span.kind).toBe('internal');
      expect(scope.span.status).toBe('unset');
      expect(scope.span.traceId).toHaveLength(32);
      expect(scope.span.spanId).toHaveLength(16);
      scope.end();
    });

    it('creates a custom span with explicit kind', () => {
      const scope = tracer.startSpan('client-span', 'client', { key: 'val' });
      expect(scope.span.kind).toBe('client');
      expect(scope.span.attributes.key).toBe('val');
      scope.end();
    });

    it('creates a workflow span with service attributes', () => {
      const scope = tracer.startWorkflowSpan('my-wf', 'wf-123', 'run-456');
      expect(scope.span.name).toBe('workflow:my-wf');
      expect(scope.span.attributes[SERVICE_NAME]).toBe('cogitator-workflow');
      expect(scope.span.attributes[SERVICE_VERSION]).toBe('1.0.0');
      expect(scope.span.attributes[WORKFLOW_NAME]).toBe('my-wf');
      expect(scope.span.attributes[WORKFLOW_ID]).toBe('wf-123');
      expect(scope.span.attributes[WORKFLOW_RUN_ID]).toBe('run-456');
      scope.end();
    });

    it('creates a node span as child of workflow span', () => {
      const wfScope = tracer.startWorkflowSpan('wf', 'id', 'run');
      const nodeScope = tracer.startNodeSpan('process', 'function');
      expect(nodeScope.span.parentSpanId).toBe(wfScope.span.spanId);
      expect(nodeScope.span.traceId).toBe(wfScope.span.traceId);
      expect(nodeScope.span.name).toBe('node:process');
      expect(nodeScope.span.attributes['node.name']).toBe('process');
      expect(nodeScope.span.attributes['node.type']).toBe('function');
      nodeScope.end();
      wfScope.end();
    });

    it('creates a tool span as child of current span', () => {
      const wfScope = tracer.startWorkflowSpan('wf', 'id', 'run');
      const toolScope = tracer.startToolSpan('calculator', { precision: 'high' });
      expect(toolScope.span.parentSpanId).toBe(wfScope.span.spanId);
      expect(toolScope.span.name).toBe('tool:calculator');
      expect(toolScope.span.kind).toBe('client');
      expect(toolScope.span.attributes['tool.name']).toBe('calculator');
      expect(toolScope.span.attributes.precision).toBe('high');
      toolScope.end();
      wfScope.end();
    });
  });

  describe('endSpan', () => {
    it('sets endTime and status on end', () => {
      const scope = tracer.startSpan('s');
      expect(scope.span.endTime).toBeUndefined();
      scope.end('ok', 'done');
      expect(scope.span.endTime).toBeGreaterThanOrEqual(scope.span.startTime);
      expect(scope.span.status).toBe('ok');
      expect(scope.span.statusMessage).toBe('done');
    });

    it('defaults status to ok', () => {
      const scope = tracer.startSpan('s');
      scope.end();
      expect(scope.span.status).toBe('ok');
    });

    it('removes span from active stack on end', () => {
      const scope = tracer.startSpan('s');
      expect(tracer.getCurrentSpan()).toBe(scope.span);
      scope.end();
      expect(tracer.getCurrentSpan()).toBeUndefined();
    });

    it('restores parent as current span after child ends', () => {
      const parent = tracer.startSpan('parent');
      const child = tracer.startSpan('child');
      expect(tracer.getCurrentSpan()).toBe(child.span);
      child.end();
      expect(tracer.getCurrentSpan()).toBe(parent.span);
      parent.end();
    });
  });

  describe('getActiveSpan / getCurrentSpan', () => {
    it('returns undefined when no spans active', () => {
      expect(tracer.getCurrentSpan()).toBeUndefined();
    });

    it('returns the most recently started span', () => {
      const s1 = tracer.startSpan('first');
      const s2 = tracer.startSpan('second');
      expect(tracer.getCurrentSpan()).toBe(s2.span);
      s2.end();
      expect(tracer.getCurrentSpan()).toBe(s1.span);
      s1.end();
    });
  });

  describe('span scope operations', () => {
    it('addEvent adds timestamped event', () => {
      const scope = tracer.startSpan('s');
      scope.addEvent('checkpoint', { step: 3 });
      expect(scope.span.events).toHaveLength(1);
      expect(scope.span.events[0].name).toBe('checkpoint');
      expect(scope.span.events[0].attributes?.step).toBe(3);
      expect(scope.span.events[0].timestamp).toBeGreaterThan(0);
      scope.end();
    });

    it('setAttribute sets a single attribute', () => {
      const scope = tracer.startSpan('s');
      scope.setAttribute('key', 'value');
      expect(scope.span.attributes.key).toBe('value');
      scope.end();
    });

    it('setAttributes merges multiple attributes', () => {
      const scope = tracer.startSpan('s', 'internal', { existing: true });
      scope.setAttributes({ a: 1, b: 2 });
      expect(scope.span.attributes.existing).toBe(true);
      expect(scope.span.attributes.a).toBe(1);
      expect(scope.span.attributes.b).toBe(2);
      scope.end();
    });

    it('recordException sets error status and adds exception event', () => {
      const scope = tracer.startSpan('s');
      const err = new Error('something broke');
      scope.recordException(err);
      expect(scope.span.status).toBe('error');
      expect(scope.span.statusMessage).toBe('something broke');
      expect(scope.span.events).toHaveLength(1);
      expect(scope.span.events[0].name).toBe('exception');
      expect(scope.span.events[0].attributes?.['exception.type']).toBe('Error');
      expect(scope.span.events[0].attributes?.['exception.message']).toBe('something broke');
      scope.end();
    });
  });

  describe('trace helper', () => {
    it('auto-creates and ends span on success', async () => {
      const result = await tracer.trace('auto-span', async (scope) => {
        expect(scope.span.name).toBe('auto-span');
        return 42;
      });
      expect(result).toBe(42);
    });

    it('records exception and re-throws on failure', async () => {
      await expect(
        tracer.trace('fail-span', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
    });
  });

  describe('W3C context propagation', () => {
    it('parses and propagates traceparent header', () => {
      const traceId = 'a'.repeat(32);
      const spanId = 'b'.repeat(16);
      tracer.setContextFromHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
      });
      const ctx = tracer.getTraceContext();
      expect(ctx).toBeDefined();
      expect(ctx!.traceId).toBe(traceId);
      expect(ctx!.spanId).toBe(spanId);
    });

    it('rejects invalid traceparent', () => {
      tracer.setContextFromHeaders({ traceparent: 'invalid' });
      expect(tracer.getTraceContext()).toBeNull();
    });

    it('parses tracestate header', () => {
      const traceId = 'a'.repeat(32);
      const spanId = 'b'.repeat(16);
      tracer.setContextFromHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
        tracestate: 'vendor=value',
      });
      expect(tracer.getTraceContext()!.traceState).toBe('vendor=value');
    });

    it('propagates context in outgoing headers', () => {
      const traceId = 'c'.repeat(32);
      const spanId = 'd'.repeat(16);
      tracer.setContextFromHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
        tracestate: 'k=v',
      });
      const headers = tracer.getContextHeaders();
      expect(headers.traceparent).toBe(`00-${traceId}-${spanId}-01`);
      expect(headers.tracestate).toBe('k=v');
    });

    it('uses inherited traceId for workflow spans', () => {
      const traceId = 'e'.repeat(32);
      const spanId = 'f'.repeat(16);
      tracer.setContextFromHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
      });
      const scope = tracer.startWorkflowSpan('wf', 'id', 'run');
      expect(scope.span.traceId).toBe(traceId);
      expect(scope.span.parentSpanId).toBe(spanId);
      scope.end();
    });
  });

  describe('baggage', () => {
    it('sets and gets baggage values', () => {
      tracer.setBaggage('tenant', 'acme');
      expect(tracer.getBaggage('tenant')).toBe('acme');
      expect(tracer.getBaggage('missing')).toBeUndefined();
    });

    it('parses baggage from headers', () => {
      tracer.setContextFromHeaders({
        baggage: 'user=alice,env=prod',
      });
      expect(tracer.getBaggage('user')).toBe('alice');
      expect(tracer.getBaggage('env')).toBe('prod');
    });

    it('includes baggage in outgoing headers', () => {
      tracer.setBaggage('key', 'value');
      const headers = tracer.getContextHeaders();
      expect(headers.baggage).toBe('key=value');
    });
  });

  describe('sampling', () => {
    it('respects enabled=false', () => {
      const disabled = new WorkflowTracer({ enabled: false });
      expect(disabled.isSampled()).toBe(false);
    });

    it('samples at rate 1.0 by default', () => {
      const t = new WorkflowTracer({ enabled: true, exporter: 'noop' });
      expect(t.isSampled()).toBe(true);
    });

    it('samples at rate 0 always rejects', () => {
      const t = new WorkflowTracer({ enabled: true, sampleRate: 0, exporter: 'noop' });
      expect(t.isSampled()).toBe(false);
    });
  });

  describe('flush and shutdown', () => {
    it('flush exports completed spans', async () => {
      const scope = tracer.startSpan('s');
      scope.end();
      await tracer.flush();
    });

    it('flush is noop when not sampled', async () => {
      const t = new WorkflowTracer({ enabled: true, sampleRate: 0, exporter: 'noop' });
      const scope = t.startSpan('s');
      scope.end();
      await t.flush();
    });

    it('shutdown flushes and shuts down exporter', async () => {
      const scope = tracer.startSpan('s');
      scope.end();
      await tracer.shutdown();
    });
  });

  describe('addLink', () => {
    it('adds a link to a span', () => {
      const scope = tracer.startSpan('s');
      tracer.addLink(scope.span, {
        traceId: 'x'.repeat(32),
        spanId: 'y'.repeat(16),
        attributes: { rel: 'caused-by' },
      });
      expect(scope.span.links).toHaveLength(1);
      expect(scope.span.links[0].attributes?.rel).toBe('caused-by');
      scope.end();
    });
  });
});

describe('WorkflowMetricsCollector', () => {
  let metrics: WorkflowMetricsCollector;

  beforeEach(() => {
    metrics = new WorkflowMetricsCollector({ prefix: 'test' });
  });

  describe('workflow recording', () => {
    it('records workflow start and completion', () => {
      metrics.recordWorkflowStart('wf-a');
      metrics.recordWorkflowComplete('wf-a', 150, 'success');

      const summary = metrics.getWorkflowMetrics('wf-a');
      expect(summary).toBeDefined();
      expect(summary!.workflowName).toBe('wf-a');
      expect(summary!.latency.avg).toBe(150);
      expect(summary!.latency.min).toBe(150);
      expect(summary!.latency.max).toBe(150);
    });

    it('tracks multiple completions', () => {
      metrics.recordWorkflowStart('wf');
      metrics.recordWorkflowComplete('wf', 100, 'success');
      metrics.recordWorkflowStart('wf');
      metrics.recordWorkflowComplete('wf', 200, 'success');
      metrics.recordWorkflowStart('wf');
      metrics.recordWorkflowComplete('wf', 300, 'failure');

      const summary = metrics.getWorkflowMetrics('wf');
      expect(summary!.latency.avg).toBe(200);
      expect(summary!.latency.min).toBe(100);
      expect(summary!.latency.max).toBe(300);
    });

    it('returns null for unknown workflow', () => {
      expect(metrics.getWorkflowMetrics('unknown')).toBeNull();
    });
  });

  describe('node recording', () => {
    it('records node execution metrics', () => {
      metrics.recordWorkflowStart('wf');
      metrics.recordNodeExecution('wf', 'parse', 'function', 50, true, 0);
      metrics.recordNodeExecution('wf', 'parse', 'function', 70, true, 1);
      metrics.recordNodeExecution('wf', 'parse', 'function', 0, false, 0);
      metrics.recordWorkflowComplete('wf', 120, 'success');

      const summary = metrics.getWorkflowMetrics('wf');
      const nodeMet = summary!.nodeMetrics.get('parse');
      expect(nodeMet).toBeDefined();
      expect(nodeMet!.executionCount).toBe(3);
      expect(nodeMet!.successCount).toBe(2);
      expect(nodeMet!.failureCount).toBe(1);
      expect(nodeMet!.retryCount).toBe(1);
      expect(nodeMet!.avgDuration).toBe(40);
    });
  });

  describe('token and cost tracking', () => {
    it('tracks token usage per workflow', () => {
      metrics.recordWorkflowStart('wf');
      metrics.recordTokenUsage('wf', 100, 50);
      metrics.recordTokenUsage('wf', 200, 100);
      metrics.recordWorkflowComplete('wf', 500, 'success');

      const summary = metrics.getWorkflowMetrics('wf');
      expect(summary!.tokenUsage.input).toBe(300);
      expect(summary!.tokenUsage.output).toBe(150);
      expect(summary!.tokenUsage.total).toBe(450);
    });

    it('tracks cost per workflow', () => {
      metrics.recordWorkflowStart('wf');
      metrics.recordCost('wf', 0.05);
      metrics.recordCost('wf', 0.1);
      metrics.recordWorkflowComplete('wf', 200, 'success');

      const summary = metrics.getWorkflowMetrics('wf');
      expect(summary!.totalCost).toBeCloseTo(0.15);
    });
  });

  describe('reset', () => {
    it('clears all metrics', () => {
      metrics.recordWorkflowStart('wf');
      metrics.recordWorkflowComplete('wf', 100, 'success');
      expect(metrics.getWorkflowNames()).toContain('wf');

      metrics.reset();
      expect(metrics.getWorkflowNames()).toHaveLength(0);
      expect(metrics.getWorkflowMetrics('wf')).toBeNull();
    });
  });

  describe('getWorkflowNames', () => {
    it('returns all tracked workflow names', () => {
      metrics.recordWorkflowStart('alpha');
      metrics.recordWorkflowComplete('alpha', 100, 'success');
      metrics.recordWorkflowStart('beta');
      metrics.recordWorkflowComplete('beta', 200, 'success');

      const names = metrics.getWorkflowNames();
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
    });
  });

  describe('toPrometheusFormat', () => {
    it('emits counter lines', () => {
      metrics.recordWorkflowStart('wf');
      const prom = metrics.toPrometheusFormat();
      expect(prom).toContain('# TYPE test_executions_total counter');
      expect(prom).toContain('test_executions_total');
    });

    it('emits gauge lines', () => {
      metrics.recordWorkflowStart('wf');
      const prom = metrics.toPrometheusFormat();
      expect(prom).toContain('# TYPE test_active_workflows gauge');
      expect(prom).toContain('test_active_workflows');
    });

    it('emits histogram lines with buckets', () => {
      metrics.recordWorkflowStart('wf');
      metrics.recordWorkflowComplete('wf', 150, 'success');
      const prom = metrics.toPrometheusFormat();
      expect(prom).toContain('# TYPE test_execution_duration_ms histogram');
      expect(prom).toContain('test_execution_duration_ms_bucket');
      expect(prom).toContain('le="+Inf"');
      expect(prom).toContain('test_execution_duration_ms_sum');
      expect(prom).toContain('test_execution_duration_ms_count');
    });

    it('deduplicates TYPE lines for same metric name', () => {
      metrics.recordWorkflowStart('wf-a');
      metrics.recordWorkflowStart('wf-b');
      const prom = metrics.toPrometheusFormat();
      const typeLines = prom
        .split('\n')
        .filter((l) => l.startsWith('# TYPE test_executions_total'));
      expect(typeLines).toHaveLength(1);
    });

    it('returns empty string when no metrics recorded', () => {
      expect(metrics.toPrometheusFormat()).toBe('');
    });
  });
});

describe('Span Exporters', () => {
  describe('ConsoleSpanExporter', () => {
    it('logs spans to console', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exporter = new ConsoleSpanExporter(false);

      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'test',
          kind: 'internal',
          startTime: 1000,
          endTime: 2000,
          attributes: {},
          events: [],
          links: [],
          status: 'ok',
        },
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('test');
      expect(spy.mock.calls[0][0]).toContain('1000ms');

      spy.mockRestore();
    });

    it('logs verbose details when enabled', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exporter = new ConsoleSpanExporter(true);

      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'verbose-test',
          kind: 'internal',
          startTime: 1000,
          endTime: 2000,
          attributes: { key: 'val' },
          events: [{ name: 'evt', timestamp: 1500 }],
          links: [],
          status: 'error',
          statusMessage: 'oops',
        },
      ]);

      expect(spy).toHaveBeenCalledTimes(4);
      spy.mockRestore();
    });

    it('shutdown is a noop', async () => {
      const exporter = new ConsoleSpanExporter();
      await exporter.shutdown();
    });
  });

  describe('NoopSpanExporter', () => {
    it('export and shutdown do nothing', async () => {
      const exporter = new NoopSpanExporter();
      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'noop',
          kind: 'internal',
          startTime: 0,
          attributes: {},
          events: [],
          links: [],
          status: 'ok',
        },
      ]);
      await exporter.shutdown();
    });
  });

  describe('CompositeSpanExporter', () => {
    it('delegates to all child exporters', async () => {
      const e1 = new NoopSpanExporter();
      const e2 = new NoopSpanExporter();
      const spy1 = vi.spyOn(e1, 'export');
      const spy2 = vi.spyOn(e2, 'export');

      const composite = new CompositeSpanExporter([e1, e2]);
      const spans = [
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'test',
          kind: 'internal' as const,
          startTime: 0,
          attributes: {},
          events: [],
          links: [],
          status: 'ok' as const,
        },
      ];

      await composite.export(spans);
      expect(spy1).toHaveBeenCalledWith(spans);
      expect(spy2).toHaveBeenCalledWith(spans);
    });

    it('shutdown delegates to all child exporters', async () => {
      const e1 = new NoopSpanExporter();
      const e2 = new NoopSpanExporter();
      const spy1 = vi.spyOn(e1, 'shutdown');
      const spy2 = vi.spyOn(e2, 'shutdown');

      const composite = new CompositeSpanExporter([e1, e2]);
      await composite.shutdown();
      expect(spy1).toHaveBeenCalled();
      expect(spy2).toHaveBeenCalled();
    });

    it('continues if one exporter fails', async () => {
      const failing = {
        export: vi.fn().mockRejectedValue(new Error('fail')),
        shutdown: vi.fn(),
      };
      const passing = new NoopSpanExporter();
      const spy = vi.spyOn(passing, 'export');

      const composite = new CompositeSpanExporter([failing, passing]);
      await composite.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'test',
          kind: 'internal',
          startTime: 0,
          attributes: {},
          events: [],
          links: [],
          status: 'ok',
        },
      ]);

      expect(failing.export).toHaveBeenCalled();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('OTLPSpanExporter', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('batches and sends spans as OTLP JSON', async () => {
      const exporter = new OTLPSpanExporter({
        endpoint: 'http://test:4318/v1/traces',
        batchSize: 1,
        flushInterval: 999999,
      });

      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 'otlp-test',
          kind: 'internal',
          startTime: 1000,
          endTime: 2000,
          attributes: { str: 'hello', num: 42, flag: true, arr: [1, 2] },
          events: [{ name: 'ev', timestamp: 1500, attributes: { x: 1 } }],
          links: [{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), attributes: { r: 'link' } }],
          status: 'ok',
          statusMessage: 'success',
        },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('http://test:4318/v1/traces');
      expect(opts.method).toBe('POST');

      const body = JSON.parse(opts.body);
      expect(body.resourceSpans).toHaveLength(1);
      const otlpSpan = body.resourceSpans[0].scopeSpans[0].spans[0];
      expect(otlpSpan.name).toBe('otlp-test');
      expect(otlpSpan.kind).toBe(1);
      expect(otlpSpan.status.code).toBe(1);

      await exporter.shutdown();
    });

    it('retries on fetch failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const exporter = new OTLPSpanExporter({
        batchSize: 1,
        flushInterval: 999999,
      });

      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 's',
          kind: 'internal',
          startTime: 0,
          attributes: {},
          events: [],
          links: [],
          status: 'ok',
        },
      ]);

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();

      fetchMock.mockResolvedValueOnce({ ok: true });
      await exporter.shutdown();
    });

    it('retries on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const exporter = new OTLPSpanExporter({
        batchSize: 1,
        flushInterval: 999999,
      });

      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 's',
          kind: 'internal',
          startTime: 0,
          attributes: {},
          events: [],
          links: [],
          status: 'ok',
        },
      ]);

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();

      fetchMock.mockResolvedValueOnce({ ok: true });
      await exporter.shutdown();
    });

    it('sends custom headers', async () => {
      const exporter = new OTLPSpanExporter({
        batchSize: 1,
        flushInterval: 999999,
        headers: { Authorization: 'Bearer token' },
      });

      await exporter.export([
        {
          traceId: 'a'.repeat(32),
          spanId: 'b'.repeat(16),
          name: 's',
          kind: 'internal',
          startTime: 0,
          attributes: {},
          events: [],
          links: [],
          status: 'ok',
        },
      ]);

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer token');
      expect(opts.headers['Content-Type']).toBe('application/json');

      await exporter.shutdown();
    });
  });
});

describe('createSpanExporter factory', () => {
  it('creates ConsoleSpanExporter for "console"', () => {
    const exporter = createSpanExporter({ type: 'console' });
    expect(exporter).toBeInstanceOf(ConsoleSpanExporter);
  });

  it('creates OTLPSpanExporter for "otlp"', () => {
    const exporter = createSpanExporter({ type: 'otlp' });
    expect(exporter).toBeInstanceOf(OTLPSpanExporter);
    void (exporter as OTLPSpanExporter).shutdown();
  });

  it('creates OTLPSpanExporter for "jaeger"', () => {
    const exporter = createSpanExporter({ type: 'jaeger' });
    expect(exporter).toBeInstanceOf(OTLPSpanExporter);
    void (exporter as OTLPSpanExporter).shutdown();
  });

  it('creates NoopSpanExporter for unknown type', () => {
    const exporter = createSpanExporter({ type: 'noop' as never });
    expect(exporter).toBeInstanceOf(NoopSpanExporter);
  });
});

describe('Factory functions', () => {
  it('createTracer returns WorkflowTracer', () => {
    const t = createTracer({ enabled: false });
    expect(t).toBeInstanceOf(WorkflowTracer);
  });

  it('createMetricsCollector returns WorkflowMetricsCollector', () => {
    const m = createMetricsCollector({ prefix: 'custom' });
    expect(m).toBeInstanceOf(WorkflowMetricsCollector);
  });
});

describe('Global tracer', () => {
  afterEach(() => {
    setGlobalTracer(new WorkflowTracer({ enabled: false }));
  });

  it('getGlobalTracer returns a disabled tracer by default', () => {
    setGlobalTracer(null as unknown as WorkflowTracer);
    const t = getGlobalTracer();
    expect(t).toBeInstanceOf(WorkflowTracer);
    expect(t.isSampled()).toBe(false);
  });

  it('setGlobalTracer / getGlobalTracer round-trips', () => {
    const custom = new WorkflowTracer({ enabled: true, exporter: 'noop' });
    setGlobalTracer(custom);
    expect(getGlobalTracer()).toBe(custom);
  });
});

describe('Global metrics', () => {
  afterEach(() => {
    setGlobalMetrics(new WorkflowMetricsCollector({ enabled: false }));
  });

  it('getGlobalMetrics returns a collector by default', () => {
    setGlobalMetrics(null as unknown as WorkflowMetricsCollector);
    const m = getGlobalMetrics();
    expect(m).toBeInstanceOf(WorkflowMetricsCollector);
  });

  it('setGlobalMetrics / getGlobalMetrics round-trips', () => {
    const custom = new WorkflowMetricsCollector({ prefix: 'global' });
    setGlobalMetrics(custom);
    expect(getGlobalMetrics()).toBe(custom);
  });
});

describe('Span attribute helpers', () => {
  it('workflowSpanAttributes builds correct attributes', () => {
    const attrs = workflowSpanAttributes('wf', 'id-1', 'run-1', { custom: true });
    expect(attrs[WORKFLOW_NAME]).toBe('wf');
    expect(attrs[WORKFLOW_ID]).toBe('id-1');
    expect(attrs[WORKFLOW_RUN_ID]).toBe('run-1');
    expect(attrs.custom).toBe(true);
  });

  it('nodeSpanAttributes builds correct attributes', () => {
    const attrs = nodeSpanAttributes('parser', 'function', 0);
    expect(attrs['node.name']).toBe('parser');
    expect(attrs['node.type']).toBe('function');
    expect(attrs['node.index']).toBe(0);
  });

  it('llmSpanAttributes includes token totals', () => {
    const attrs = llmSpanAttributes('openai', 'gpt-4', 100, 50, 0.01);
    expect(attrs['llm.system']).toBe('openai');
    expect(attrs['llm.request.model']).toBe('gpt-4');
    expect(attrs['llm.usage.input_tokens']).toBe(100);
    expect(attrs['llm.usage.output_tokens']).toBe(50);
    expect(attrs['llm.usage.total_tokens']).toBe(150);
    expect(attrs['llm.usage.cost']).toBe(0.01);
  });

  it('llmSpanAttributes omits cost when undefined', () => {
    const attrs = llmSpanAttributes('openai', 'gpt-4', 10, 5);
    expect(attrs).not.toHaveProperty('llm.usage.cost');
  });

  it('toolSpanAttributes builds correct attributes', () => {
    const attrs = toolSpanAttributes('search', true, 250);
    expect(attrs['tool.name']).toBe('search');
    expect(attrs['tool.success']).toBe(true);
    expect(attrs['tool.duration_ms']).toBe(250);
  });

  it('errorSpanAttributes captures error details', () => {
    const err = new TypeError('bad input');
    const attrs = errorSpanAttributes(err);
    expect(attrs['error.type']).toBe('TypeError');
    expect(attrs['error.message']).toBe('bad input');
    expect(attrs['error.stack']).toBeDefined();
  });

  it('retrySpanAttributes builds correct attributes', () => {
    const attrs = retrySpanAttributes(2, 5, 1000);
    expect(attrs['retry.attempt']).toBe(2);
    expect(attrs['retry.max']).toBe(5);
    expect(attrs['retry.delay_ms']).toBe(1000);
  });
});
