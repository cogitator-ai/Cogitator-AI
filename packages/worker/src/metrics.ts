/**
 * Prometheus metrics for queue monitoring
 *
 * Provides metrics in Prometheus exposition format for:
 * - Queue depth (key HPA metric)
 * - Job counts by state
 * - Worker count
 * - Processing times
 */

import type { QueueMetrics } from './types.js';

/**
 * Format queue metrics as Prometheus exposition format
 */
export function formatPrometheusMetrics(
  metrics: QueueMetrics,
  labels?: Record<string, string>
): string {
  const labelStr = labels
    ? Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')
    : '';
  const labelSuffix = labelStr ? `{${labelStr}}` : '';

  const lines: string[] = [
    '# HELP cogitator_queue_depth Total number of jobs waiting to be processed',
    '# TYPE cogitator_queue_depth gauge',
    `cogitator_queue_depth${labelSuffix} ${metrics.depth}`,
    '',
    '# HELP cogitator_queue_waiting Number of jobs in waiting state',
    '# TYPE cogitator_queue_waiting gauge',
    `cogitator_queue_waiting${labelSuffix} ${metrics.waiting}`,
    '',
    '# HELP cogitator_queue_active Number of jobs currently being processed',
    '# TYPE cogitator_queue_active gauge',
    `cogitator_queue_active${labelSuffix} ${metrics.active}`,
    '',
    '# HELP cogitator_queue_completed_total Total number of completed jobs',
    '# TYPE cogitator_queue_completed_total counter',
    `cogitator_queue_completed_total${labelSuffix} ${metrics.completed}`,
    '',
    '# HELP cogitator_queue_failed_total Total number of failed jobs',
    '# TYPE cogitator_queue_failed_total counter',
    `cogitator_queue_failed_total${labelSuffix} ${metrics.failed}`,
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
  private buckets: Map<number, number> = new Map();
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
      }
    }
  }

  /**
   * Format as Prometheus exposition format
   */
  format(labels?: Record<string, string>): string {
    const labelStr = labels
      ? Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',')
      : '';

    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

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
   * Format all metrics
   */
  format(queueMetrics: QueueMetrics, labels?: Record<string, string>): string {
    const parts = [
      formatPrometheusMetrics(queueMetrics, labels),
      this.jobDuration.format(labels),
    ];

    if (this.jobsByType.size > 0) {
      parts.push('# HELP cogitator_jobs_by_type_total Jobs processed by type');
      parts.push('# TYPE cogitator_jobs_by_type_total counter');
      for (const [type, count] of this.jobsByType) {
        const typeLabels = labels
          ? `${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')},type="${type}"`
          : `type="${type}"`;
        parts.push(`cogitator_jobs_by_type_total{${typeLabels}} ${count}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }
}
