import type {
  CostRoutingConfig,
  TaskRequirements,
  ModelRecommendation,
  CostRecord,
  CostSummary,
} from '@cogitator-ai/types';
import { calculateCost, getPricing } from '@cogitator-ai/models';
import { getLogger } from '../logger';
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
  private readonly unpricedModels = new Set<string>();

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

  /**
   * Whether a run that has really spent `runCost` so far may make another model call, against
   * the per-run, hourly and daily limits. The runtime asks before every call.
   */
  checkSpent(runCost: number): BudgetCheckResult {
    if (!this.budgetEnforcer) return { allowed: true };
    return this.budgetEnforcer.checkSpent(runCost);
  }

  /**
   * Records what a model call cost. The runtime records each call as it is answered, so a run
   * that fails or is cancelled still counts, and runs side by side see each other's spending.
   * A budget keeps its records even with `trackCosts: false`, since its limits are read from them.
   */
  recordCost(record: Omit<CostRecord, 'timestamp'>): void {
    if (this.config.trackCosts || this.budgetEnforcer) {
      this.costTracker.record(record);
    }
  }

  /**
   * Warns once per model that a budget is set but calls to `model` cannot be counted against it:
   * the provider reported no cost and the model registry has no price for it, so they count as $0.
   * The runtime calls it for each such call.
   */
  noteUnreportedCost(model: string): void {
    if (!this.budgetEnforcer || this.unpricedModels.has(model)) return;
    this.unpricedModels.add(model);
    if (getPricing(model)) return;
    getLogger().warn(
      `No price is known for ${model}, so the cost-routing budget counts its calls as $0. Load the full model catalogue with initializeModels() from @cogitator-ai/models at startup, or use a provider that reports its cost.`,
      { model }
    );
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
