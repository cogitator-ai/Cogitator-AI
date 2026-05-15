import type {
  PromptPerformanceMetrics,
  DegradationAlert,
  MonitoringConfig,
  AlertType,
  AlertSeverity,
  AlertAction,
  ExecutionTrace,
} from '@cogitator-ai/types';

export interface PromptMonitorConfig extends MonitoringConfig {
  onAlert?: (alert: DegradationAlert) => void;
}

interface MetricWindow {
  scores: number[];
  latencies: number[];
  costs: number[];
  errors: number;
  total: number;
  windowStart: Date;
}

const DEFAULT_CONFIG: Required<Omit<MonitoringConfig, 'onAlert'>> = {
  windowSize: 60 * 60 * 1000,
  scoreDropThreshold: 0.15,
  latencySpikeThreshold: 2.0,
  errorRateThreshold: 0.1,
  enableAutoRollback: false,
  rollbackCooldown: 24 * 60 * 60 * 1000,
};

export class PromptMonitor {
  private config: Required<Omit<MonitoringConfig, 'onAlert'>> & {
    onAlert?: (alert: DegradationAlert) => void;
  };
  private windows = new Map<string, MetricWindow>();
  private baselines = new Map<string, PromptPerformanceMetrics>();
  private alerts = new Map<string, DegradationAlert[]>();
  private lastRollback = new Map<string, Date>();

  constructor(config: PromptMonitorConfig = {}) {
    this.config = {
      windowSize: config.windowSize ?? DEFAULT_CONFIG.windowSize,
      scoreDropThreshold: config.scoreDropThreshold ?? DEFAULT_CONFIG.scoreDropThreshold,
      latencySpikeThreshold: config.latencySpikeThreshold ?? DEFAULT_CONFIG.latencySpikeThreshold,
      errorRateThreshold: config.errorRateThreshold ?? DEFAULT_CONFIG.errorRateThreshold,
      enableAutoRollback: config.enableAutoRollback ?? DEFAULT_CONFIG.enableAutoRollback,
      rollbackCooldown: config.rollbackCooldown ?? DEFAULT_CONFIG.rollbackCooldown,
      onAlert: config.onAlert,
    };
  }

  recordExecution(trace: ExecutionTrace): DegradationAlert[] {
    const agentId = trace.agentId;
    const window = this.getOrCreateWindow(agentId);

    this.rotateWindowIfNeeded(agentId, window);

    if (trace.score !== undefined) {
      window.scores.push(trace.score);
    }
    if (trace.duration !== undefined) {
      window.latencies.push(trace.duration);
    }
    if (trace.usage?.cost !== undefined) {
      window.costs.push(trace.usage.cost);
    }
    if (!trace.metrics?.success) {
      window.errors++;
    }
    window.total++;

    return this.checkForDegradation(agentId, window);
  }

  setBaseline(agentId: string, metrics: PromptPerformanceMetrics): void {
    this.baselines.set(agentId, metrics);
  }

  computeBaselineFromHistory(agentId: string, traces: ExecutionTrace[]): PromptPerformanceMetrics {
    const scores = traces.filter((t) => t.score !== undefined).map((t) => t.score!);
    const latencies = traces.filter((t) => t.duration !== undefined).map((t) => t.duration!);
    const costs = traces.filter((t) => t.usage?.cost !== undefined).map((t) => t.usage.cost!);
    const errors = traces.filter((t) => !t.metrics?.success).length;

    const now = new Date();
    const windowStart = new Date(now.getTime() - this.config.windowSize);

    const metrics: PromptPerformanceMetrics = {
      agentId,
      windowStart,
      windowEnd: now,
      totalRuns: traces.length,
      successfulRuns: traces.length - errors,
      failedRuns: errors,
      avgScore: this.mean(scores),
      minScore: scores.length > 0 ? Math.min(...scores) : 0,
      maxScore: scores.length > 0 ? Math.max(...scores) : 0,
      scoreP50: this.percentile(scores, 0.5),
      scoreP95: this.percentile(scores, 0.95),
      avgLatency: this.mean(latencies),
      p50Latency: this.percentile(latencies, 0.5),
      p95Latency: this.percentile(latencies, 0.95),
      p99Latency: this.percentile(latencies, 0.99),
      totalCost: costs.reduce((a, b) => a + b, 0),
      avgCostPerRun: traces.length > 0 ? costs.reduce((a, b) => a + b, 0) / traces.length : 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
    };

    this.baselines.set(agentId, metrics);
    return metrics;
  }

  getCurrentMetrics(agentId: string): PromptPerformanceMetrics | null {
    const window = this.windows.get(agentId);
    if (!window || window.total === 0) {
      return null;
    }

    const now = new Date();

    return {
      agentId,
      windowStart: window.windowStart,
      windowEnd: now,
      totalRuns: window.total,
      successfulRuns: window.total - window.errors,
      failedRuns: window.errors,
      avgScore: this.mean(window.scores),
      minScore: window.scores.length > 0 ? Math.min(...window.scores) : 0,
      maxScore: window.scores.length > 0 ? Math.max(...window.scores) : 0,
      scoreP50: this.percentile(window.scores, 0.5),
      scoreP95: this.percentile(window.scores, 0.95),
      avgLatency: this.mean(window.latencies),
      p50Latency: this.percentile(window.latencies, 0.5),
      p95Latency: this.percentile(window.latencies, 0.95),
      p99Latency: this.percentile(window.latencies, 0.99),
      totalCost: window.costs.reduce((a, b) => a + b, 0),
      avgCostPerRun: window.total > 0 ? window.costs.reduce((a, b) => a + b, 0) / window.total : 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
    };
  }

  getAlerts(agentId: string): DegradationAlert[] {
    return this.alerts.get(agentId) || [];
  }

  getActiveAlerts(agentId: string): DegradationAlert[] {
    const alerts = this.alerts.get(agentId) || [];
    return alerts.filter((a) => !a.resolvedAt);
  }

  resolveAlert(alertId: string): void {
    for (const [, alerts] of this.alerts) {
      const alert = alerts.find((a) => a.id === alertId);
      if (alert) {
        alert.resolvedAt = new Date();
        break;
      }
    }
  }

  canRollback(agentId: string): boolean {
    if (!this.config.enableAutoRollback) {
      return false;
    }

    const lastRollback = this.lastRollback.get(agentId);
    if (!lastRollback) {
      return true;
    }

    return Date.now() - lastRollback.getTime() >= this.config.rollbackCooldown;
  }

  recordRollback(agentId: string): void {
    this.lastRollback.set(agentId, new Date());
  }

  clearWindow(agentId: string): void {
    this.windows.delete(agentId);
  }

  private getOrCreateWindow(agentId: string): MetricWindow {
    let window = this.windows.get(agentId);
    if (!window) {
      window = {
        scores: [],
        latencies: [],
        costs: [],
        errors: 0,
        total: 0,
        windowStart: new Date(),
      };
      this.windows.set(agentId, window);
    }
    return window;
  }

  private rotateWindowIfNeeded(agentId: string, window: MetricWindow): void {
    const elapsed = Date.now() - window.windowStart.getTime();
    if (elapsed >= this.config.windowSize) {
      const currentMetrics = this.getCurrentMetrics(agentId);
      if (currentMetrics && window.total >= 10) {
        this.baselines.set(agentId, currentMetrics);
      }

      window.scores = [];
      window.latencies = [];
      window.costs = [];
      window.errors = 0;
      window.total = 0;
      window.windowStart = new Date();
    }
  }

  private checkForDegradation(agentId: string, window: MetricWindow): DegradationAlert[] {
    const baseline = this.baselines.get(agentId);
    if (!baseline || window.total < 5) {
      return [];
    }

    const newAlerts: DegradationAlert[] = [];

    const currentAvgScore = this.mean(window.scores);
    if (baseline.avgScore > 0 && window.scores.length > 0) {
      const scoreChange = (baseline.avgScore - currentAvgScore) / baseline.avgScore;
      if (scoreChange >= this.config.scoreDropThreshold) {
        const alert = this.createAlert(
          agentId,
          'score_drop',
          currentAvgScore,
          baseline.avgScore,
          this.config.scoreDropThreshold,
          scoreChange
        );
        newAlerts.push(alert);
      }
    }

    const currentAvgLatency = this.mean(window.latencies);
    if (baseline.avgLatency > 0 && currentAvgLatency > 0) {
      const latencyRatio = currentAvgLatency / baseline.avgLatency;
      if (latencyRatio >= this.config.latencySpikeThreshold) {
        const alert = this.createAlert(
          agentId,
          'latency_spike',
          currentAvgLatency,
          baseline.avgLatency,
          this.config.latencySpikeThreshold,
          latencyRatio - 1
        );
        newAlerts.push(alert);
      }
    }

    const errorRate = window.total > 0 ? window.errors / window.total : 0;
    const baselineErrorRate = baseline.totalRuns > 0 ? baseline.failedRuns / baseline.totalRuns : 0;
    if (errorRate > this.config.errorRateThreshold && errorRate > baselineErrorRate * 2) {
      const alert = this.createAlert(
        agentId,
        'error_rate_increase',
        errorRate,
        baselineErrorRate,
        this.config.errorRateThreshold,
        baselineErrorRate > 0 ? (errorRate - baselineErrorRate) / baselineErrorRate : errorRate
      );
      newAlerts.push(alert);
    }

    const currentAvgCost =
      window.total > 0 ? window.costs.reduce((a, b) => a + b, 0) / window.total : 0;
    if (baseline.avgCostPerRun > 0 && currentAvgCost > baseline.avgCostPerRun * 2) {
      const alert = this.createAlert(
        agentId,
        'cost_spike',
        currentAvgCost,
        baseline.avgCostPerRun,
        2.0,
        (currentAvgCost - baseline.avgCostPerRun) / baseline.avgCostPerRun
      );
      newAlerts.push(alert);
    }

    if (newAlerts.length > 0) {
      const existing = this.alerts.get(agentId) || [];
      this.alerts.set(agentId, [...existing, ...newAlerts]);

      for (const alert of newAlerts) {
        if (this.config.onAlert) {
          this.config.onAlert(alert);
        }
      }
    }

    return newAlerts;
  }

  private createAlert(
    agentId: string,
    type: AlertType,
    currentValue: number,
    baselineValue: number,
    threshold: number,
    percentChange: number
  ): DegradationAlert {
    const severity: AlertSeverity = percentChange > threshold * 2 ? 'critical' : 'warning';
    const autoAction: AlertAction =
      this.config.enableAutoRollback && severity === 'critical' ? 'rollback' : 'alert_only';

    return {
      id: `alert-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      agentId,
      type,
      severity,
      currentValue,
      baselineValue,
      threshold,
      percentChange,
      detectedAt: new Date(),
      autoAction,
      actionTaken: false,
    };
  }

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.floor(p * (sorted.length - 1));
    return sorted[index];
  }
}
