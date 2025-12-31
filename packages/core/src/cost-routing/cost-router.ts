import type {
  CostRoutingConfig,
  TaskRequirements,
  ModelRecommendation,
  CostRecord,
  CostSummary,
} from '@cogitator-ai/types';
import { TaskAnalyzer } from './task-analyzer';
import { ModelSelector } from './model-selector';
import { CostTracker } from './cost-tracker';
import { BudgetEnforcer, type BudgetCheckResult } from './budget-enforcer';

export interface CostAwareRouterOptions {
  config?: Partial<CostRoutingConfig>;
}

const DEFAULT_CONFIG: CostRoutingConfig = {
  enabled: true,
  autoSelectModel: false,
  preferLocal: true,
  minCapabilityMatch: 0.3,
  trackCosts: true,
};

export class CostAwareRouter {
  private taskAnalyzer: TaskAnalyzer;
  private modelSelector: ModelSelector;
  private costTracker: CostTracker;
  private budgetEnforcer?: BudgetEnforcer;
  private config: CostRoutingConfig;

  constructor(options: CostAwareRouterOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.taskAnalyzer = new TaskAnalyzer();
    this.modelSelector = new ModelSelector(this.config);
    this.costTracker = new CostTracker();

    if (this.config.budget) {
      this.budgetEnforcer = new BudgetEnforcer(this.config.budget, this.costTracker);
    }
  }

  analyzeTask(input: string): TaskRequirements {
    return this.taskAnalyzer.analyze(input);
  }

  async recommendModel(input: string): Promise<ModelRecommendation> {
    const requirements = this.analyzeTask(input);
    return this.modelSelector.selectModel(requirements);
  }

  async recommendModelForRequirements(requirements: TaskRequirements): Promise<ModelRecommendation> {
    return this.modelSelector.selectModel(requirements);
  }

  checkBudget(estimatedCost: number): BudgetCheckResult {
    if (!this.budgetEnforcer) return { allowed: true };
    return this.budgetEnforcer.checkBudget(estimatedCost);
  }

  recordCost(record: Omit<CostRecord, 'timestamp'>): void {
    if (this.config.trackCosts) {
      this.costTracker.record(record);
    }
  }

  getRunCost(runId: string): number {
    return this.costTracker.getRunCost(runId);
  }

  getHourlyCost(): number {
    return this.costTracker.getHourlyCost();
  }

  getDailyCost(): number {
    return this.costTracker.getDailyCost();
  }

  getCostSummary(): CostSummary {
    return this.costTracker.getSummary();
  }

  getBudgetStatus() {
    return this.budgetEnforcer?.getBudgetStatus();
  }

  getConfig(): CostRoutingConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<CostRoutingConfig>): void {
    this.config = { ...this.config, ...config };
    this.modelSelector = new ModelSelector(this.config);

    if (this.config.budget) {
      this.budgetEnforcer = new BudgetEnforcer(this.config.budget, this.costTracker);
    } else {
      this.budgetEnforcer = undefined;
    }
  }

  clearCostHistory(): void {
    this.costTracker.clear();
    this.budgetEnforcer?.resetWarnings();
  }
}
