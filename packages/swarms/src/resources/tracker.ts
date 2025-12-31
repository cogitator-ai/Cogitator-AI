/**
 * Resource tracking for swarm execution
 */

import type {
  SwarmResourceConfig,
  SwarmResourceUsage,
  RunResult,
} from '@cogitator-ai/types';

export class ResourceTracker {
  private config: SwarmResourceConfig;
  private startTime: number;
  private totalTokens = 0;
  private totalCost = 0;
  private agentUsage = new Map<string, { tokens: number; cost: number; runs: number; duration: number }>();

  constructor(config: SwarmResourceConfig = {}) {
    this.config = config;
    this.startTime = Date.now();
  }

  trackAgentRun(agentName: string, result: RunResult): void {
    const usage = this.agentUsage.get(agentName) ?? {
      tokens: 0,
      cost: 0,
      runs: 0,
      duration: 0,
    };

    usage.tokens += result.usage.totalTokens;
    usage.cost += result.usage.cost;
    usage.runs += 1;
    usage.duration += result.usage.duration;

    this.agentUsage.set(agentName, usage);

    this.totalTokens += result.usage.totalTokens;
    this.totalCost += result.usage.cost;
  }

  isWithinBudget(): boolean {
    return this.checkLimit('tokens') && this.checkLimit('cost') && this.checkLimit('time');
  }

  checkLimit(type: 'tokens' | 'cost' | 'time'): boolean {
    switch (type) {
      case 'tokens':
        if (this.config.tokenBudget === undefined) return true;
        return this.totalTokens < this.config.tokenBudget;

      case 'cost':
        if (this.config.costLimit === undefined) return true;
        return this.totalCost < this.config.costLimit;

      case 'time':
        if (this.config.timeout === undefined) return true;
        return this.getElapsedTime() < this.config.timeout;

      default:
        return true;
    }
  }

  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  getRemainingBudget(): {
    tokens: number | undefined;
    cost: number | undefined;
    time: number | undefined;
  } {
    return {
      tokens: this.config.tokenBudget
        ? Math.max(0, this.config.tokenBudget - this.totalTokens)
        : undefined,
      cost: this.config.costLimit
        ? Math.max(0, this.config.costLimit - this.totalCost)
        : undefined,
      time: this.config.timeout
        ? Math.max(0, this.config.timeout - this.getElapsedTime())
        : undefined,
    };
  }

  getUsage(): SwarmResourceUsage {
    return {
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      elapsedTime: this.getElapsedTime(),
      agentUsage: new Map(this.agentUsage),
    };
  }

  getAgentUsage(agentName: string): { tokens: number; cost: number; runs: number; duration: number } | undefined {
    return this.agentUsage.get(agentName);
  }

  reset(): void {
    this.startTime = Date.now();
    this.totalTokens = 0;
    this.totalCost = 0;
    this.agentUsage.clear();
  }
}
