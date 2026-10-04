/**
 * Prometheus metrics for queue monitoring
 *
 * Provides metrics in Prometheus exposition format for:
 * - Queue depth (key HPA metric)
 * - Job counts by state
 * - Worker count
 * - Processing times
 */

import type { QueueMetrics } from './types';

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render Prometheus label pairs (without braces), escaping values per the exposition format.
 */
function renderLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  return Object.entries(labels)
    .map(([name, value]) => {
      if (!LABEL_NAME.test(name)) {
        throw new Error(`Invalid Prometheus label name: ${name}`);
      }
      return `${name}="${escapeLabelValue(value)}"`;
    })
    .join(',');
}

/**
 * Format queue metrics as Prometheus exposition format
 */
export function formatPrometheusMetrics(
  metrics: QueueMetrics,
  labels?: Record<string, string>
): string {
  const labelStr = renderLabels(labels);
  const labelSuffix = labelStr ? `{${labelStr}}` : '';

  const lines: string[] = [
    '# HELP cogitator_queue_depth Jobs waiting to be processed (ready, prioritized and delayed)',
    '# TYPE cogitator_queue_depth gauge',
    `cogitator_queue_depth${labelSuffix} ${metrics.depth}`,
    '',
    '# HELP cogitator_queue_waiting Jobs ready to be processed, prioritized jobs included',
    '# TYPE cogitator_queue_waiting gauge',
    `cogitator_queue_waiting${labelSuffix} ${metrics.waiting}`,
    '',
    '# HELP cogitator_queue_active Number of jobs currently being processed',
    '# TYPE cogitator_queue_active gauge',
    `cogitator_queue_active${labelSuffix} ${metrics.active}`,
    '',
    '# HELP cogitator_queue_completed Completed jobs kept in Redis (capped by removeOnComplete)',
    '# TYPE cogitator_queue_completed gauge',
    `cogitator_queue_completed${labelSuffix} ${metrics.completed}`,
    '',
    '# HELP cogitator_queue_failed Failed jobs kept in Redis (capped by removeOnFail)',
    '# TYPE cogitator_queue_failed gauge',
    `cogitator_queue_failed${labelSuffix} ${metrics.failed}`,
    '',
    '# HELP cogitator_queue_delayed Number of delayed/scheduled jobs',
    '# TYPE cogitator_queue_delayed gauge',
    `cogitator_queue_delayed${labelSuffix} ${metrics.delayed}`,
    '',
    '# HELP cogitator_workers_total Number of active workers',
    '# TYPE cogitator_workers_total gauge',
    `cogitator_workers_total${labelSuffix} ${metrics.workerCount}`,
    '',
  ];

  return lines.join('\n');
}

/**
 * Job timing histogram buckets (in seconds)
 */
const DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

/**
 * Simple histogram tracker for job durations
 */
export class DurationHistogram {
  private buckets = new Map<number, number>();
  private sum = 0;
  private count = 0;
  private readonly name: string;
  private readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
    for (const bucket of DURATION_BUCKETS) {
      this.buckets.set(bucket, 0);
    }
  }

  /**
   * Record a duration observation
   */
  observe(durationSeconds: number): void {
    this.sum += durationSeconds;
    this.count++;
    for (const bucket of DURATION_BUCKETS) {
      if (durationSeconds <= bucket) {
        this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
        break;
      }
    }
  }

  /**
   * Format as Prometheus exposition format
   */
  format(labels?: Record<string, string>): string {
    const labelStr = renderLabels(labels);

    const lines: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];

    let cumulative = 0;
    for (const bucket of DURATION_BUCKETS) {
      cumulative += this.buckets.get(bucket) ?? 0;
      const bucketLabels = labelStr ? `${labelStr},le="${bucket}"` : `le="${bucket}"`;
      lines.push(`${this.name}_bucket{${bucketLabels}} ${cumulative}`);
    }

    const infLabels = labelStr ? `${labelStr},le="+Inf"` : `le="+Inf"`;
    lines.push(`${this.name}_bucket{${infLabels}} ${this.count}`);

    const sumSuffix = labelStr ? `{${labelStr}}` : '';
    lines.push(`${this.name}_sum${sumSuffix} ${this.sum}`);
    lines.push(`${this.name}_count${sumSuffix} ${this.count}`);
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Reset the histogram
   */
  reset(): void {
    this.sum = 0;
    this.count = 0;
    for (const bucket of DURATION_BUCKETS) {
      this.buckets.set(bucket, 0);
    }
  }
}

/**
 * Metrics collector for worker pool
 */
export class MetricsCollector {
  readonly jobDuration: DurationHistogram;
  private jobsByType = new Map<string, number>();
  private failedJobsByType = new Map<string, number>();

  constructor() {
    this.jobDuration = new DurationHistogram(
      'cogitator_job_duration_seconds',
      'Job processing duration in seconds'
    );
  }

  /**
   * Record a completed job
   */
  recordJob(type: string, durationMs: number): void {
    this.jobDuration.observe(durationMs / 1000);
    this.jobsByType.set(type, (this.jobsByType.get(type) ?? 0) + 1);
  }

  /**
   * Record a job that failed its last attempt
   */
  recordFailure(type: string): void {
    this.failedJobsByType.set(type, (this.failedJobsByType.get(type) ?? 0) + 1);
  }

  /**
   * Format all metrics
   */
  format(queueMetrics: QueueMetrics, labels?: Record<string, string>): string {
    const parts = [formatPrometheusMetrics(queueMetrics, labels), this.jobDuration.format(labels)];

    parts.push(
      ...formatCounterByType(
        'cogitator_jobs_by_type_total',
        'Jobs processed by type',
        this.jobsByType,
        labels
      ),
      ...formatCounterByType(
        'cogitator_jobs_failed_total',
        'Jobs that failed their last attempt, by type',
        this.failedJobsByType,
        labels
      )
    );

    return parts.join('\n');
  }
}

function formatCounterByType(
  name: string,
  help: string,
  counts: ReadonlyMap<string, number>,
  labels: Record<string, string> | undefined
): string[] {
  if (counts.size === 0) return [];
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const [type, count] of counts) {
    lines.push(`${name}{${renderLabels({ ...labels, type })}} ${count}`);
  }
  lines.push('');
  return lines;
}
