import { describe, it, expect, beforeEach } from 'vitest';
import { formatPrometheusMetrics, DurationHistogram, MetricsCollector } from '../metrics';
import type { QueueMetrics } from '../types';

describe('Prometheus Metrics', () => {
  const sampleMetrics: QueueMetrics = {
    waiting: 10,
    active: 3,
    completed: 500,
    failed: 5,
    delayed: 2,
    depth: 12,
    workerCount: 4,
  };

  describe('formatPrometheusMetrics', () => {
    it('formats basic metrics', () => {
      const output = formatPrometheusMetrics(sampleMetrics);

      expect(output).toContain('cogitator_queue_depth 12');
      expect(output).toContain('cogitator_queue_waiting 10');
      expect(output).toContain('cogitator_queue_active 3');
      expect(output).toContain('cogitator_queue_completed 500');
      expect(output).toContain('cogitator_queue_failed 5');
      expect(output).toContain('cogitator_queue_delayed 2');
      expect(output).toContain('cogitator_workers_total 4');
    });

    it('includes HELP and TYPE annotations', () => {
      const output = formatPrometheusMetrics(sampleMetrics);

      expect(output).toContain('# HELP cogitator_queue_depth');
      expect(output).toContain('# TYPE cogitator_queue_depth gauge');
      expect(output).toContain('# TYPE cogitator_queue_delayed gauge');
    });

    it('exports the retained completed and failed job counts as gauges, not counters', () => {
      const output = formatPrometheusMetrics(sampleMetrics);

      expect(output).toContain('# TYPE cogitator_queue_completed gauge');
      expect(output).toContain('# TYPE cogitator_queue_failed gauge');
      expect(output).not.toMatch(/^# TYPE cogitator_queue_\w+ counter$/m);
    });

    it('formats metrics with labels', () => {
      const output = formatPrometheusMetrics(sampleMetrics, {
        environment: 'production',
        region: 'us-east-1',
      });

      expect(output).toContain('environment="production"');
      expect(output).toContain('region="us-east-1"');
      expect(output).toContain(
        'cogitator_queue_depth{environment="production",region="us-east-1"} 12'
      );
    });
  });

  describe('DurationHistogram', () => {
    let histogram: DurationHistogram;

    beforeEach(() => {
      histogram = new DurationHistogram('test_duration_seconds', 'Test duration in seconds');
    });

    it('records observations', () => {
      histogram.observe(0.5);
      histogram.observe(1.5);
      histogram.observe(3.0);

      const output = histogram.format();

      expect(output).toContain('test_duration_seconds_sum 5');
      expect(output).toContain('test_duration_seconds_count 3');
    });

    it('tracks bucket distribution (cumulative)', () => {
      const freshHistogram = new DurationHistogram('bucket_test', 'Bucket test');
      freshHistogram.observe(0.05);
      freshHistogram.observe(0.5);
      freshHistogram.observe(2);
      freshHistogram.observe(15);

      const output = freshHistogram.format();

      expect(output).toContain('bucket_test_bucket{le="0.1"} 1');
      expect(output).toContain('bucket_test_bucket{le="1"} 2');
      expect(output).toContain('bucket_test_bucket{le="2.5"} 3');
      expect(output).toContain('bucket_test_bucket{le="+Inf"} 4');
    });

    it('formats with labels', () => {
      histogram.observe(1.0);

      const output = histogram.format({ job_type: 'agent' });

      expect(output).toContain('job_type="agent"');
      expect(output).toContain('job_type="agent",le="1"');
    });

    it('includes HELP and TYPE annotations', () => {
      const output = histogram.format();

      expect(output).toContain('# HELP test_duration_seconds Test duration in seconds');
      expect(output).toContain('# TYPE test_duration_seconds histogram');
    });

    it('resets all values', () => {
      histogram.observe(1.0);
      histogram.observe(2.0);
      histogram.reset();

      const output = histogram.format();

      expect(output).toContain('test_duration_seconds_sum 0');
      expect(output).toContain('test_duration_seconds_count 0');
    });
  });

  describe('MetricsCollector', () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it('records job completions', () => {
      collector.recordJob('agent', 500);
      collector.recordJob('workflow', 1000);
      collector.recordJob('agent', 300);

      const output = collector.format(sampleMetrics);

      expect(output).toContain('cogitator_jobs_by_type_total{type="agent"} 2');
      expect(output).toContain('cogitator_jobs_by_type_total{type="workflow"} 1');
    });

    it('counts jobs that failed their last attempt by type', () => {
      collector.recordFailure('agent');
      collector.recordFailure('agent');
      collector.recordFailure('swarm');

      const output = collector.format(sampleMetrics, { cluster: 'main' });

      expect(output).toContain('# TYPE cogitator_jobs_failed_total counter');
      expect(output).toContain('cogitator_jobs_failed_total{cluster="main",type="agent"} 2');
      expect(output).toContain('cogitator_jobs_failed_total{cluster="main",type="swarm"} 1');
    });

    it('omits the failure counter until a job fails', () => {
      expect(collector.format(sampleMetrics)).not.toContain('cogitator_jobs_failed_total');
    });

    it('tracks job durations', () => {
      collector.recordJob('agent', 500);
      collector.recordJob('agent', 1500);

      const output = collector.format(sampleMetrics);

      expect(output).toContain('cogitator_job_duration_seconds_sum 2');
      expect(output).toContain('cogitator_job_duration_seconds_count 2');
    });

    it('combines queue metrics with job metrics', () => {
      collector.recordJob('agent', 500);

      const output = collector.format(sampleMetrics);

      expect(output).toContain('cogitator_queue_depth 12');
      expect(output).toContain('cogitator_job_duration_seconds');
      expect(output).toContain('cogitator_jobs_by_type_total');
    });

    it('formats with labels', () => {
      collector.recordJob('agent', 500);

      const output = collector.format(sampleMetrics, { cluster: 'main' });

      expect(output).toContain('cluster="main"');
    });
  });
});
