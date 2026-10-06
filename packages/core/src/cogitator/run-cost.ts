import { calculateCost, type TokenUsageForCost } from '@cogitator-ai/models';
import type { ChatUsage, RunCostState, RunCostTokens } from '@cogitator-ai/types';

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
 * that price; the tokens of the others are kept by the model that answered and priced from the
 * model registry when the total is asked for, so a run that hands off to another model counts
 * each call at its own model's price. The state survives a pause in the run checkpoint, and a
 * checkpoint without it prices all its tokens from the registry.
 */
export class RunCostMeter {
  private reportedUsd: number;
  private readonly unattributed: RunCostTokens;
  private readonly byModel = new Map<string, RunCostTokens>();

  constructor(saved?: RunCostState, tokensSoFar?: RunCostTokens) {
    this.reportedUsd = saved?.reportedUsd ?? 0;
    this.unattributed = { ...(saved?.unreported ?? tokensSoFar ?? noTokens()) };
    for (const [model, tokens] of Object.entries(saved?.unreportedByModel ?? {})) {
      this.byModel.set(model, { ...tokens });
    }
  }

  /** Counts one call `model` answered. */
  add(usage: ChatUsage, model: string): void {
    if (usage.cost !== undefined && Number.isFinite(usage.cost)) {
      this.reportedUsd += usage.cost;
      return;
    }
    const tokens = this.byModel.get(model) ?? noTokens();
    tokens.inputTokens += usage.inputTokens;
    tokens.outputTokens += usage.outputTokens;
    tokens.cachedInputTokens += usage.cachedInputTokens ?? 0;
    tokens.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    if (usage.cacheWrite1hTokens) {
      tokens.cacheWrite1hTokens = (tokens.cacheWrite1hTokens ?? 0) + usage.cacheWrite1hTokens;
    }
    this.byModel.set(model, tokens);
  }

  /**
   * Total USD so far: each model's unreported tokens at its own price, and tokens a checkpoint
   * kept without their model at the price of `runModel`, the model the run was started on.
   */
  total(runModel: string): number {
    let usd = this.reportedUsd;
    for (const [model, tokens] of this.byModel) usd += priced(model, tokens);
    return usd + priced(runModel, this.unattributed);
  }

  state(): RunCostState {
    return {
      reportedUsd: this.reportedUsd,
      unreported: { ...this.unattributed },
      ...(this.byModel.size > 0 && {
        unreportedByModel: Object.fromEntries(
          [...this.byModel].map(([model, tokens]) => [model, { ...tokens }])
        ),
      }),
    };
  }
}

function noTokens(): RunCostTokens {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
}

function priced(model: string, tokens: RunCostTokens): number {
  return tokens.inputTokens > 0 || tokens.outputTokens > 0 ? registryCost(model, tokens) : 0;
}
