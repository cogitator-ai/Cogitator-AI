import type { BudgetConfig } from '@cogitator-ai/types';
import type { CostTracker } from './cost-tracker';

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export class BudgetEnforcer {
  private config: BudgetConfig;
  private tracker: CostTracker;
  private warningTriggered = {
    hourly: false,
    daily: false,
  };

  constructor(config: BudgetConfig, tracker: CostTracker) {
    this.config = config;
    this.tracker = tracker;
  }

  checkBudget(estimatedCost: number): BudgetCheckResult {
    if (this.config.maxCostPerRun && estimatedCost > this.config.maxCostPerRun) {
      this.triggerExceeded(estimatedCost, this.config.maxCostPerRun);
      return {
        allowed: false,
        reason: `Estimated cost $${estimatedCost.toFixed(4)} exceeds per-run limit $${this.config.maxCostPerRun}`,
      };
    }

    if (this.config.maxCostPerHour) {
      const hourly = this.tracker.getHourlyCost();
      if (hourly + estimatedCost > this.config.maxCostPerHour) {
        this.triggerExceeded(hourly + estimatedCost, this.config.maxCostPerHour);
        return {
          allowed: false,
          reason: `Would exceed hourly budget ($${hourly.toFixed(2)} + $${estimatedCost.toFixed(4)} > $${this.config.maxCostPerHour})`,
        };
      }
      this.checkHourlyWarning(hourly);
    }

    if (this.config.maxCostPerDay) {
      const daily = this.tracker.getDailyCost();
      if (daily + estimatedCost > this.config.maxCostPerDay) {
        this.triggerExceeded(daily + estimatedCost, this.config.maxCostPerDay);
        return {
          allowed: false,
          reason: `Would exceed daily budget ($${daily.toFixed(2)} + $${estimatedCost.toFixed(4)} > $${this.config.maxCostPerDay})`,
        };
      }
      this.checkDailyWarning(daily);
    }

    return { allowed: true };
  }

  getBudgetStatus(): {
    hourlyUsed: number;
    hourlyLimit?: number;
    dailyUsed: number;
    dailyLimit?: number;
    hourlyRemaining?: number;
    dailyRemaining?: number;
  } {
    const hourlyUsed = this.tracker.getHourlyCost();
    const dailyUsed = this.tracker.getDailyCost();

    return {
      hourlyUsed,
      hourlyLimit: this.config.maxCostPerHour,
      dailyUsed,
      dailyLimit: this.config.maxCostPerDay,
      hourlyRemaining: this.config.maxCostPerHour
        ? Math.max(0, this.config.maxCostPerHour - hourlyUsed)
        : undefined,
      dailyRemaining: this.config.maxCostPerDay
        ? Math.max(0, this.config.maxCostPerDay - dailyUsed)
        : undefined,
    };
  }

  resetWarnings(): void {
    this.warningTriggered.hourly = false;
    this.warningTriggered.daily = false;
  }

  private checkHourlyWarning(current: number): void {
    if (!this.config.maxCostPerHour || this.warningTriggered.hourly) return;

    const threshold = this.config.warningThreshold ?? 0.8;
    if (current / this.config.maxCostPerHour >= threshold) {
      this.warningTriggered.hourly = true;
      this.config.onBudgetWarning?.(current, this.config.maxCostPerHour);
    }
  }

  private checkDailyWarning(current: number): void {
    if (!this.config.maxCostPerDay || this.warningTriggered.daily) return;

    const threshold = this.config.warningThreshold ?? 0.8;
    if (current / this.config.maxCostPerDay >= threshold) {
      this.warningTriggered.daily = true;
      this.config.onBudgetWarning?.(current, this.config.maxCostPerDay);
    }
  }

  private triggerExceeded(current: number, limit: number): void {
    this.config.onBudgetExceeded?.(current, limit);
  }
}
