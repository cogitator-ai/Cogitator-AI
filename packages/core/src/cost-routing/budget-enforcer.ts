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

  /** Whether a run estimated to cost this much may start, before it has spent anything. */
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

  /**
   * Whether a run may make another model call, by what has really been spent: the run's own
   * cost against `maxCostPerRun`, and every run's in the last hour and day against the hourly
   * and daily limits. Checked before each call, so a call in flight can take spending past a
   * limit by its own cost, never further.
   */
  checkSpent(runCost: number): BudgetCheckResult {
    if (this.config.maxCostPerRun && runCost >= this.config.maxCostPerRun) {
      this.triggerExceeded(runCost, this.config.maxCostPerRun);
      return {
        allowed: false,
        reason: `The run has spent $${runCost.toFixed(4)}, which reaches its per-run limit $${this.config.maxCostPerRun}`,
      };
    }

    if (this.config.maxCostPerHour) {
      const hourly = this.tracker.getHourlyCost();
      if (hourly >= this.config.maxCostPerHour) {
        this.triggerExceeded(hourly, this.config.maxCostPerHour);
        return {
          allowed: false,
          reason: `$${hourly.toFixed(4)} spent in the last hour reaches the hourly budget $${this.config.maxCostPerHour}`,
        };
      }
      this.checkHourlyWarning(hourly);
    }

    if (this.config.maxCostPerDay) {
      const daily = this.tracker.getDailyCost();
      if (daily >= this.config.maxCostPerDay) {
        this.triggerExceeded(daily, this.config.maxCostPerDay);
        return {
          allowed: false,
          reason: `$${daily.toFixed(4)} spent in the last day reaches the daily budget $${this.config.maxCostPerDay}`,
        };
      }
      this.checkDailyWarning(daily);
    }

    return { allowed: true };
  }

  /**
   * What has been spent against each limit that is set: the run's own cost against
   * `maxCostPerRun`, every run's in the last hour and day against the hourly and daily limits.
   * Nothing is triggered, for a run that pauses at a limit instead of failing
   */
  spentAgainstLimits(
    runCost: number
  ): Array<{ scope: 'run' | 'hour' | 'day'; used: number; limit: number }> {
    const limits: Array<{ scope: 'run' | 'hour' | 'day'; used: number; limit: number }> = [];
    if (this.config.maxCostPerRun) {
      limits.push({ scope: 'run', used: runCost, limit: this.config.maxCostPerRun });
    }
    if (this.config.maxCostPerHour) {
      limits.push({
        scope: 'hour',
        used: this.tracker.getHourlyCost(),
        limit: this.config.maxCostPerHour,
      });
    }
    if (this.config.maxCostPerDay) {
      limits.push({
        scope: 'day',
        used: this.tracker.getDailyCost(),
        limit: this.config.maxCostPerDay,
      });
    }
    return limits;
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
