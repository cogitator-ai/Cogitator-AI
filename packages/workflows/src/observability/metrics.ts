/**
 * WorkflowMetricsCollector - Metrics collection for workflow execution
 *
 * Features:
 * - Counters for executions, successes, failures
 * - Histograms for latency distribution
 * - Gauges for active workflows, queue depth
 * - Per-node and per-workflow metrics
 * - Token and cost tracking
 * - Prometheus-compatible output
 */

import type { MetricsConfig, WorkflowMetrics, NodeMetrics } from '@cogitator-ai/types';

const DEFAULT_LATENCY_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const DEFAULT_TOKEN_BUCKETS = [100, 500, 1000, 5000, 10000, 50000, 100000];
const DEFAULT_COST_BUCKETS = [0.001, 0.01, 0.1, 0.5, 1, 5, 10, 50];

interface HistogramData {
  buckets: Map<number, number>;
  sum: number;
  count: number;
  min: number;
  max: number;
}

interface CounterData {
  value: number;
  labels: Record<string, string>;
}

interface GaugeData {
  value: number;
  labels: Record<string, string>;
}

interface LatencySample {
  value: number;
  timestamp: number;
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, idx)];
}

/**
 * WorkflowMetricsCollector - Main metrics collection class
 */
export class WorkflowMetricsCollector {
  private config: MetricsConfig;
  private counters = new Map<string, CounterData>();
  private gauges = new Map<string, GaugeData>();
  private histograms = new Map<string, HistogramData>();
  private latencySamples = new Map<string, LatencySample[]>();
  private nodeMetrics = new Map<string, Map<string, NodeMetricsData>>();
  private tokenUsage = new Map<string, TokenUsageData>();
  private costTracking = new Map<string, number>();
  private lastUpdated: number = Date.now();

  constructor(config: Partial<MetricsConfig> = {}) {
    this.config = {
      enabled: true,
      prefix: 'cogitator_workflow',
      labels: {},
      latencyBuckets: DEFAULT_LATENCY_BUCKETS,
      tokenBuckets: DEFAULT_TOKEN_BUCKETS,
      costBuckets: DEFAULT_COST_BUCKETS,
      ...config,
    };
  }

  /**
   * Get prefixed metric name
   */
  private metricName(name: string): string {
    return this.config.prefix ? `${this.config.prefix}_${name}` : name;
  }

  /**
   * Record workflow start
   */
  recordWorkflowStart(workflowName: string, labels?: Record<string, string>): void {
    const key = this.metricName('executions_total');
    this.incrementCounter(key, { workflow: workflowName, ...labels });

    const activeKey = this.metricName('active_workflows');
    this.incrementGauge(activeKey, { workflow: workflowName });
  }

  /**
   * Record workflow completion
   */
  recordWorkflowComplete(
    workflowName: string,
    durationMs: number,
    status: 'success' | 'failure' | 'cancelled',
    labels?: Record<string, string>
  ): void {
    const activeKey = this.metricName('active_workflows');
    this.decrementGauge(activeKey, { workflow: workflowName });

    const statusKey = this.metricName(`executions_${status}_total`);
    this.incrementCounter(statusKey, { workflow: workflowName, ...labels });

    const latencyKey = this.metricName('execution_duration_ms');
    this.recordHistogram(latencyKey, durationMs, { workflow: workflowName });

    this.recordLatencySample(workflowName, durationMs);

    this.lastUpdated = Date.now();
  }

  /**
   * Record node execution
   */
  recordNodeExecution(
    workflowName: string,
    nodeName: string,
    nodeType: string,
    durationMs: number,
    success: boolean,
    retries = 0
  ): void {
    if (!this.nodeMetrics.has(workflowName)) {
      this.nodeMetrics.set(workflowName, new Map());
    }

    const workflowNodes = this.nodeMetrics.get(workflowName)!;

    if (!workflowNodes.has(nodeName)) {
      workflowNodes.set(nodeName, {
        executionCount: 0,
        successCount: 0,
        failureCount: 0,
        retryCount: 0,
        durations: [],
      });
    }

    const nodeData = workflowNodes.get(nodeName)!;
    nodeData.executionCount++;
    nodeData.durations.push(durationMs);

    if (success) {
      nodeData.successCount++;
    } else {
      nodeData.failureCount++;
    }

    nodeData.retryCount += retries;

    const nodeLatencyKey = this.metricName('node_duration_ms');
    this.recordHistogram(nodeLatencyKey, durationMs, {
      workflow: workflowName,
      node: nodeName,
      type: nodeType,
    });

    const nodeExecKey = this.metricName('node_executions_total');
    this.incrementCounter(nodeExecKey, {
      workflow: workflowName,
      node: nodeName,
      status: success ? 'success' : 'failure',
    });
  }

  /**
   * Record token usage
   */
  recordTokenUsage(workflowName: string, inputTokens: number, outputTokens: number): void {
    if (!this.tokenUsage.has(workflowName)) {
      this.tokenUsage.set(workflowName, {
        input: 0,
        output: 0,
        total: 0,
      });
    }

    const usage = this.tokenUsage.get(workflowName)!;
    usage.input += inputTokens;
    usage.output += outputTokens;
    usage.total += inputTokens + outputTokens;

    const tokenKey = this.metricName('tokens_total');
    this.recordHistogram(tokenKey, inputTokens + outputTokens, {
      workflow: workflowName,
    });
  }

  /**
   * Record cost
   */
  recordCost(workflowName: string, cost: number): void {
    const current = this.costTracking.get(workflowName) ?? 0;
    this.costTracking.set(workflowName, current + cost);

    const costKey = this.metricName('cost_usd');
    this.recordHistogram(costKey, cost, { workflow: workflowName });
  }

  /**
   * Get workflow metrics summary
   */
  getWorkflowMetrics(workflowName: string): WorkflowMetrics | null {
    const samples = this.latencySamples.get(workflowName);
    if (!samples || samples.length === 0) {
      return null;
    }

    const durations = samples.map((s) => s.value).sort((a, b) => a - b);

    const totalKey = this.metricName('executions_total');
    const successKey = this.metricName('executions_success_total');
    const failureKey = this.metricName('executions_failure_total');
    const cancelledKey = this.metricName('executions_cancelled_total');

    const getCounterValue = (key: string): number => {
      const counter = this.counters.get(`${key}:workflow=${workflowName}`);
      return counter?.value ?? 0;
    };

    const nodeMetricsMap = new Map<string, NodeMetrics>();
    const workflowNodes = this.nodeMetrics.get(workflowName);

    if (workflowNodes) {
      for (const [nodeName, data] of workflowNodes) {
        const sortedDurations = [...data.durations].sort((a, b) => a - b);
        const avg = sortedDurations.reduce((sum, d) => sum + d, 0) / sortedDurations.length;

        nodeMetricsMap.set(nodeName, {
          executionCount: data.executionCount,
          successCount: data.successCount,
          failureCount: data.failureCount,
          retryCount: data.retryCount,
          avgDuration: avg,
          p50Duration: percentile(sortedDurations, 50),
          p95Duration: percentile(sortedDurations, 95),
          p99Duration: percentile(sortedDurations, 99),
          minDuration: sortedDurations[0] ?? 0,
          maxDuration: sortedDurations[sortedDurations.length - 1] ?? 0,
        });
      }
    }

    const tokenData = this.tokenUsage.get(workflowName) ?? {
      input: 0,
      output: 0,
      total: 0,
    };

    const totalCost = this.costTracking.get(workflowName) ?? 0;

    return {
      workflowName,
      executionCount: getCounterValue(totalKey),
      successCount: getCounterValue(successKey),
      failureCount: getCounterValue(failureKey),
      cancelledCount: getCounterValue(cancelledKey),
      latency: {
        avg: durations.reduce((sum, d) => sum + d, 0) / durations.length,
        p50: percentile(durations, 50),
        p90: percentile(durations, 90),
        p99: percentile(durations, 99),
        min: durations[0],
        max: durations[durations.length - 1],
      },
      nodeMetrics: nodeMetricsMap,
      tokenUsage: tokenData,
      totalCost,
      lastUpdated: this.lastUpdated,
    };
  }

  /**
   * Increment counter
   */
  private incrementCounter(name: string, labels?: Record<string, string>, value = 1): void {
    const key = this.labeledKey(name, labels);
    const current = this.counters.get(key);

    if (current) {
      current.value += value;
    } else {
      this.counters.set(key, {
        value,
        labels: { ...this.config.labels, ...labels },
      });
    }
  }

  /**
   * Set gauge value
   */
  private setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labeledKey(name, labels);
    this.gauges.set(key, {
      value,
      labels: { ...this.config.labels, ...labels },
    });
  }

  /**
   * Increment gauge
   */
  private incrementGauge(name: string, labels?: Record<string, string>): void {
    const key = this.labeledKey(name, labels);
    const current = this.gauges.get(key);
    this.setGauge(name, (current?.value ?? 0) + 1, labels);
  }

  /**
   * Decrement gauge
   */
  private decrementGauge(name: string, labels?: Record<string, string>): void {
    const key = this.labeledKey(name, labels);
    const current = this.gauges.get(key);
    this.setGauge(name, Math.max(0, (current?.value ?? 0) - 1), labels);
  }

  /**
   * Record histogram value
   */
  private recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labeledKey(name, labels);
    let histogram = this.histograms.get(key);

    if (!histogram) {
      const buckets = this.getBucketsForMetric(name);
      histogram = {
        buckets: new Map(buckets.map((b) => [b, 0])),
        sum: 0,
        count: 0,
        min: Infinity,
        max: -Infinity,
      };
      this.histograms.set(key, histogram);
    }

    histogram.sum += value;
    histogram.count++;
    histogram.min = Math.min(histogram.min, value);
    histogram.max = Math.max(histogram.max, value);

    for (const [bucket, count] of histogram.buckets) {
      if (value <= bucket) {
        histogram.buckets.set(bucket, count + 1);
      }
    }
  }

  /**
   * Record latency sample for percentile calculations
   */
  private recordLatencySample(workflowName: string, value: number): void {
    if (!this.latencySamples.has(workflowName)) {
      this.latencySamples.set(workflowName, []);
    }

    const samples = this.latencySamples.get(workflowName)!;
    samples.push({ value, timestamp: Date.now() });

    if (samples.length > 1000) {
      samples.shift();
    }
  }

  /**
   * Get appropriate buckets for a metric
   */
  private getBucketsForMetric(name: string): number[] {
    if (name.includes('duration') || name.includes('latency')) {
      return this.config.latencyBuckets ?? DEFAULT_LATENCY_BUCKETS;
    }
    if (name.includes('token')) {
      return this.config.tokenBuckets ?? DEFAULT_TOKEN_BUCKETS;
    }
    if (name.includes('cost')) {
      return this.config.costBuckets ?? DEFAULT_COST_BUCKETS;
    }
    return DEFAULT_LATENCY_BUCKETS;
  }

  /**
   * Build labeled key for maps
   */
  private labeledKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return name;
    }

    const labelPairs = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    return `${name}:${labelPairs}`;
  }

  /**
   * Export metrics in Prometheus text format
   */
  toPrometheusFormat(): string {
    const lines: string[] = [];
    const emittedTypes = new Set<string>();

    for (const [key, data] of this.counters) {
      const [name] = key.split(':');
      const labelStr = this.formatPrometheusLabels(data.labels);
      if (!emittedTypes.has(name)) {
        lines.push(`# TYPE ${name} counter`);
        emittedTypes.add(name);
      }
      lines.push(`${name}${labelStr} ${data.value.toString()}`);
    }

    for (const [key, data] of this.gauges) {
      const [name] = key.split(':');
      const labelStr = this.formatPrometheusLabels(data.labels);
      if (!emittedTypes.has(name)) {
        lines.push(`# TYPE ${name} gauge`);
        emittedTypes.add(name);
      }
      lines.push(`${name}${labelStr} ${data.value.toString()}`);
    }

    for (const [key, data] of this.histograms) {
      const [name, labelsPart] = key.split(':');
      const labels = this.parseLabels(labelsPart);
      const baseLabelStr = this.formatPrometheusLabels(labels);

      if (!emittedTypes.has(name)) {
        lines.push(`# TYPE ${name} histogram`);
        emittedTypes.add(name);
      }

      for (const [bucket, count] of data.buckets) {
        const bucketLabels = { ...labels, le: bucket.toString() };
        lines.push(
          `${name}_bucket${this.formatPrometheusLabels(bucketLabels)} ${count.toString()}`
        );
      }

      const infLabels = { ...labels, le: '+Inf' };
      lines.push(
        `${name}_bucket${this.formatPrometheusLabels(infLabels)} ${data.count.toString()}`
      );

      lines.push(`${name}_sum${baseLabelStr} ${data.sum.toString()}`);
      lines.push(`${name}_count${baseLabelStr} ${data.count.toString()}`);
    }

    return lines.join('\n');
  }

  /**
   * Format labels for Prometheus
   */
  private formatPrometheusLabels(labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return '';
    }

    const pairs = Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');

    return `{${pairs}}`;
  }

  /**
   * Parse labels from key
   */
  private parseLabels(labelsPart?: string): Record<string, string> {
    if (!labelsPart) return {};

    const labels: Record<string, string> = {};
    const pairs = labelsPart.split(',');

    for (const pair of pairs) {
      const [k, v] = pair.split('=');
      if (k && v) {
        labels[k] = v;
      }
    }

    return labels;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.latencySamples.clear();
    this.nodeMetrics.clear();
    this.tokenUsage.clear();
    this.costTracking.clear();
    this.lastUpdated = Date.now();
  }

  /**
   * Get all workflow names with metrics
   */
  getWorkflowNames(): string[] {
    const names = new Set<string>();

    for (const [key] of this.counters) {
      const match = /workflow=([^,}]+)/.exec(key);
      if (match) {
        names.add(match[1]);
      }
    }

    for (const name of this.latencySamples.keys()) {
      names.add(name);
    }

    return [...names];
  }
}

/**
 * Create a metrics collector instance
 */
export function createMetricsCollector(config?: Partial<MetricsConfig>): WorkflowMetricsCollector {
  return new WorkflowMetricsCollector(config);
}

/**
 * Global metrics collector for convenience
 */
let globalMetrics: WorkflowMetricsCollector | null = null;

export function getGlobalMetrics(): WorkflowMetricsCollector {
  if (!globalMetrics) {
    globalMetrics = new WorkflowMetricsCollector({ enabled: false });
  }
  return globalMetrics;
}

export function setGlobalMetrics(metrics: WorkflowMetricsCollector): void {
  globalMetrics = metrics;
}

interface NodeMetricsData {
  executionCount: number;
  successCount: number;
  failureCount: number;
  retryCount: number;
  durations: number[];
}

interface TokenUsageData {
  input: number;
  output: number;
  total: number;
}
