import type {
  CostRoutingConfig,
  TaskRequirements,
  ModelRecommendation,
  CostRecord,
  CostSummary,
} from '@cogitator-ai/types';
import { calculateCost } from '@cogitator-ai/models';
import { TaskAnalyzer } from './task-analyzer';
import { ModelSelector, TASK_TOKEN_ESTIMATES } from './model-selector';
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

  async recommendModelForRequirements(
    requirements: TaskRequirements
  ): Promise<ModelRecommendation> {
    return this.modelSelector.selectModel(requirements);
  }

  /**
   * The best model for `input` among the providers `isProviderAvailable`
   * accepts — the ones a runtime can actually call. Unlike
   * {@link recommendModel} there is no fallback: undefined when none of
   * those providers has a fitting model.
   */
  async recommendAvailableModel(
    input: string,
    isProviderAvailable: (provider: string) => boolean
  ): Promise<ModelRecommendation | undefined> {
    return this.modelSelector.selectAvailableModel(this.analyzeTask(input), isProviderAvailable);
  }

  /**
   * Checks the budget for a run of `input` on `model`, estimating its cost
   * from the task's complexity and the model's price (0 when the price is
   * unknown, so the hourly and daily limits still hold against what was spent).
   */
  checkRunBudget(input: string, model: string): BudgetCheckResult {
    if (!this.budgetEnforcer) return { allowed: true };
    const tokens = TASK_TOKEN_ESTIMATES[this.analyzeTask(input).complexity];
    return this.budgetEnforcer.checkBudget(calculateCost(model, tokens) ?? 0);
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
