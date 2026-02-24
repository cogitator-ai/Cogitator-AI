import type {
  ExecutionTrace,
  AutoOptimizationConfig,
  OptimizationRun,
  OptimizationRunStatus,
  Agent,
  ABTestOutcome,
  DegradationAlert,
} from '@cogitator-ai/types';
import type { AgentOptimizer } from './agent-optimizer';
import type { ABTestingFramework } from './ab-testing';
import type { PromptMonitor } from './prompt-monitor';
import type { RollbackManager } from './rollback-manager';

export interface AutoOptimizerConfig extends AutoOptimizationConfig {
  agentOptimizer: AgentOptimizer;
  abTesting: ABTestingFramework;
  monitor: PromptMonitor;
  rollbackManager: RollbackManager;
  onOptimizationStart?: (run: OptimizationRun) => void;
  onOptimizationComplete?: (run: OptimizationRun) => void;
  onRollback?: (agentId: string, reason: string) => void;
}

interface ResolvedAutoOptConfig {
  enabled: boolean;
  triggerAfterRuns: number;
  minRunsForOptimization: number;
  requireABTest: boolean;
  maxOptimizationsPerDay: number;
  agentOptimizer: AgentOptimizer;
  abTesting: ABTestingFramework;
  monitor: PromptMonitor;
  rollbackManager: RollbackManager;
  onOptimizationStart?: (run: OptimizationRun) => void;
  onOptimizationComplete?: (run: OptimizationRun) => void;
  onRollback?: (agentId: string, reason: string) => void;
}

const DEFAULT_VALUES = {
  enabled: false,
  triggerAfterRuns: 100,
  minRunsForOptimization: 20,
  requireABTest: true,
  maxOptimizationsPerDay: 3,
};

export class AutoOptimizer {
  private config: ResolvedAutoOptConfig;
  private agentOptimizer: AgentOptimizer;
  private abTesting: ABTestingFramework;
  private monitor: PromptMonitor;
  private rollbackManager: RollbackManager;

  private runCounts = new Map<string, number>();
  private dailyOptimizations = new Map<string, { date: string; count: number }>();
  private activeRuns = new Map<string, OptimizationRun>();

  constructor(config: AutoOptimizerConfig) {
    this.config = {
      enabled: config.enabled ?? DEFAULT_VALUES.enabled,
      triggerAfterRuns: config.triggerAfterRuns ?? DEFAULT_VALUES.triggerAfterRuns,
      minRunsForOptimization:
        config.minRunsForOptimization ?? DEFAULT_VALUES.minRunsForOptimization,
      requireABTest: config.requireABTest ?? DEFAULT_VALUES.requireABTest,
      maxOptimizationsPerDay:
        config.maxOptimizationsPerDay ?? DEFAULT_VALUES.maxOptimizationsPerDay,
      agentOptimizer: config.agentOptimizer,
      abTesting: config.abTesting,
      monitor: config.monitor,
      rollbackManager: config.rollbackManager,
      onOptimizationStart: config.onOptimizationStart,
      onOptimizationComplete: config.onOptimizationComplete,
      onRollback: config.onRollback,
    };
    this.agentOptimizer = config.agentOptimizer;
    this.abTesting = config.abTesting;
    this.monitor = config.monitor;
    this.rollbackManager = config.rollbackManager;
  }

  async recordExecution(trace: ExecutionTrace): Promise<void> {
    if (!this.config.enabled) return;

    const agentId = trace.agentId;

    const count = (this.runCounts.get(agentId) ?? 0) + 1;
    this.runCounts.set(agentId, count);

    const alerts = this.monitor.recordExecution(trace);
    await this.handleAlerts(agentId, alerts);

    const activeABTest = await this.abTesting.getActiveTest(agentId);
    if (activeABTest && trace.score !== undefined) {
      const currentVersion = await this.rollbackManager.getCurrentVersion(agentId);
      const variant =
        currentVersion?.instructions === activeABTest.treatmentInstructions
          ? 'treatment'
          : 'control';

      await this.abTesting.recordResult(
        activeABTest.id,
        variant,
        trace.score,
        trace.duration ?? 0,
        trace.usage?.cost ?? 0
      );

      const outcome = await this.abTesting.checkAndCompleteIfReady(activeABTest.id);
      if (outcome) {
        await this.handleABTestCompletion(agentId, activeABTest.id, outcome);
      }
    }

    if (trace.score !== undefined) {
      await this.rollbackManager.recordMetrics(
        agentId,
        trace.score,
        trace.duration ?? 0,
        trace.usage?.cost ?? 0,
        trace.metrics?.success ?? true
      );
    }

    if (count >= this.config.triggerAfterRuns && (await this.shouldTriggerOptimization(agentId))) {
      await this.triggerOptimization(agentId);
      this.runCounts.set(agentId, 0);
    }
  }

  async triggerOptimization(agentId: string): Promise<OptimizationRun> {
    const run = this.createOptimizationRun(agentId);
    this.activeRuns.set(agentId, run);

    if (this.config.onOptimizationStart) {
      this.config.onOptimizationStart(run);
    }

    try {
      run.status = 'optimizing';

      const currentVersion = await this.rollbackManager.getCurrentVersion(agentId);
      const currentInstructions = currentVersion?.instructions ?? '';

      const agent = { id: agentId, instructions: currentInstructions } as Agent;
      const optimizationResult = await this.agentOptimizer.compile(agent, [], {
        maxRounds: 2,
        optimizeInstructions: true,
      });

      if (!optimizationResult.success || optimizationResult.improvement <= 0) {
        run.status = 'completed';
        run.completedAt = new Date();
        run.error = optimizationResult.errors.join('; ') || 'No improvement found';

        if (this.config.onOptimizationComplete) {
          this.config.onOptimizationComplete(run);
        }
        return run;
      }

      const newInstructions = optimizationResult.instructionsAfter ?? currentInstructions;

      if (this.config.requireABTest) {
        run.status = 'testing';

        const abTest = await this.abTesting.createTest({
          agentId,
          name: `Auto-optimization ${new Date().toISOString()}`,
          controlInstructions: currentInstructions,
          treatmentInstructions: newInstructions,
        });

        run.abTestId = abTest.id;
        await this.abTesting.startTest(abTest.id);
      } else {
        run.status = 'deploying';

        const newVersion = await this.rollbackManager.deployVersion(
          agentId,
          newInstructions,
          'optimization',
          run.id
        );

        run.deployedVersionId = newVersion.id;
        run.status = 'completed';
        run.completedAt = new Date();
      }

      this.incrementDailyCount(agentId);
    } catch (error) {
      run.status = 'failed';
      run.completedAt = new Date();
      run.error = error instanceof Error ? error.message : String(error);
    }

    if (run.status === 'completed' || run.status === 'failed') {
      if (this.config.onOptimizationComplete) {
        this.config.onOptimizationComplete(run);
      }
    }

    return run;
  }

  async forceRollback(agentId: string, reason: string): Promise<boolean> {
    if (!this.monitor.canRollback(agentId)) {
      return false;
    }

    const result = await this.rollbackManager.rollbackToPrevious(agentId);

    if (result.success) {
      this.monitor.recordRollback(agentId);
      this.monitor.clearWindow(agentId);

      const activeRun = this.activeRuns.get(agentId);
      if (activeRun && activeRun.status !== 'completed') {
        activeRun.status = 'rolled_back';
        activeRun.completedAt = new Date();
        activeRun.error = reason;

        if (this.config.onOptimizationComplete) {
          this.config.onOptimizationComplete(activeRun);
        }
      }

      if (this.config.onRollback) {
        this.config.onRollback(agentId, reason);
      }
    }

    return result.success;
  }

  getActiveRun(agentId: string): OptimizationRun | null {
    return this.activeRuns.get(agentId) ?? null;
  }

  getRunCount(agentId: string): number {
    return this.runCounts.get(agentId) ?? 0;
  }

  getDailyOptimizationCount(agentId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const daily = this.dailyOptimizations.get(agentId);
    if (daily?.date !== today) {
      return 0;
    }
    return daily.count;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  private async shouldTriggerOptimization(agentId: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    const activeRun = this.activeRuns.get(agentId);
    if (activeRun && !['completed', 'failed', 'rolled_back'].includes(activeRun.status)) {
      return false;
    }

    const activeABTest = await this.abTesting.getActiveTest(agentId);
    if (activeABTest) {
      return false;
    }

    const dailyCount = this.getDailyOptimizationCount(agentId);
    if (dailyCount >= this.config.maxOptimizationsPerDay) {
      return false;
    }

    return true;
  }

  private async handleAlerts(agentId: string, alerts: DegradationAlert[]): Promise<void> {
    for (const alert of alerts) {
      if (alert.severity === 'critical' && alert.autoAction === 'rollback') {
        const rolled = await this.forceRollback(agentId, `Critical alert: ${alert.type}`);
        if (rolled) {
          alert.actionTaken = true;
        }
      }
    }
  }

  private async handleABTestCompletion(
    agentId: string,
    testId: string,
    outcome: ABTestOutcome
  ): Promise<void> {
    const activeRun = this.activeRuns.get(agentId);
    if (activeRun?.abTestId !== testId) {
      return;
    }

    activeRun.abTestOutcome = outcome;

    if (outcome.winner === 'treatment') {
      activeRun.status = 'deploying';

      const test = await this.abTesting.getTest(testId);
      if (test) {
        const newVersion = await this.rollbackManager.deployVersion(
          agentId,
          test.treatmentInstructions,
          'ab_test',
          testId
        );
        activeRun.deployedVersionId = newVersion.id;
      }

      activeRun.status = 'completed';
    } else {
      activeRun.status = 'completed';
    }

    activeRun.completedAt = new Date();

    if (this.config.onOptimizationComplete) {
      this.config.onOptimizationComplete(activeRun);
    }
  }

  private createOptimizationRun(agentId: string): OptimizationRun {
    return {
      id: `opt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      agentId,
      status: 'pending' as OptimizationRunStatus,
      startedAt: new Date(),
    };
  }

  private incrementDailyCount(agentId: string): void {
    const today = new Date().toISOString().split('T')[0];
    const current = this.dailyOptimizations.get(agentId);

    if (current?.date !== today) {
      this.dailyOptimizations.set(agentId, { date: today, count: 1 });
    } else {
      current.count++;
    }
  }
}
