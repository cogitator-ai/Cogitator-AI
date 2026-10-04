import { calculateCost, type TokenUsageForCost } from '@cogitator-ai/models';
import type { ChatUsage, RunCostState } from '@cogitator-ai/types';

/**
 * USD for `usage` on `model`, the full model string a run uses (`openrouter/vendor/model`,
 * `openai/gpt-4o`, ...), so the registry can price that provider's listing. `0` when the
 * registry does not know the model.
 */
export function registryCost(model: string, usage: TokenUsageForCost): number {
  return calculateCost(model, usage) ?? 0;
}

/** The cost of one call: what the provider reported, otherwise the registry price. */
export function callCost(model: string, usage: ChatUsage): number {
  return usage.cost ?? registryCost(model, usage);
}

/**
 * Adds up a run's cost over its model calls. A call whose provider reports its cost counts at
 * that price; the tokens of the others are priced from the model registry. The state survives a
 * pause in the run checkpoint, and a checkpoint without it prices all its tokens from the registry.
 */
export class RunCostMeter {
  private reportedUsd: number;
  private readonly unreported: RunCostState['unreported'];

  constructor(
    saved?: RunCostState,
    tokensSoFar?: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
    }
  ) {
    this.reportedUsd = saved?.reportedUsd ?? 0;
    this.unreported = saved
      ? { ...saved.unreported }
      : {
          inputTokens: tokensSoFar?.inputTokens ?? 0,
          outputTokens: tokensSoFar?.outputTokens ?? 0,
          cachedInputTokens: tokensSoFar?.cachedInputTokens ?? 0,
          cacheWriteTokens: tokensSoFar?.cacheWriteTokens ?? 0,
        };
  }

  add(usage: ChatUsage): void {
    if (usage.cost !== undefined && Number.isFinite(usage.cost)) {
      this.reportedUsd += usage.cost;
      return;
    }
    this.unreported.inputTokens += usage.inputTokens;
    this.unreported.outputTokens += usage.outputTokens;
    this.unreported.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.unreported.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  /** Total USD so far, pricing unreported tokens on `model`. */
  total(model: string): number {
    const hasUnreported = this.unreported.inputTokens > 0 || this.unreported.outputTokens > 0;
    return this.reportedUsd + (hasUnreported ? registryCost(model, this.unreported) : 0);
  }

  state(): RunCostState {
    return { reportedUsd: this.reportedUsd, unreported: { ...this.unreported } };
  }
}
