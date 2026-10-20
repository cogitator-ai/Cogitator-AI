import {
  ModelPricer,
  type ModelPricing,
  type PricingOverrides,
  type TokenUsageForCost,
} from '@cogitator-ai/models';
import type { ChatUsage, RunCostState, RunCostTokens } from '@cogitator-ai/types';
import { getLogger } from '../logger';

/** Providers that run on your own hardware: their calls cost nothing unless `llm.pricing` says otherwise. */
const SELF_HOSTED_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'vllm']);

/**
 * Prices the model calls of one runtime: by `llm.pricing` first, then by the model registry.
 * A call to a model with neither counts as $0, and the runtime warns about that model once,
 * unless it runs on a self-hosted provider (Ollama, vLLM), whose calls are free.
 */
export class CallPricer {
  private readonly pricer: ModelPricer;
  private readonly warned = new Set<string>();

  constructor(overrides?: PricingOverrides) {
    this.pricer = new ModelPricer(overrides);
  }

  /** The price of `model`, the full model string a run uses (`openai/gpt-4o`, `openrouter/vendor/model`). */
  pricing(model: string): ModelPricing | null {
    return this.pricer.pricing(model);
  }

  /** USD for `usage` on `model`, `0` when its price is unknown. */
  cost(model: string, usage: TokenUsageForCost): number {
    return this.costOrNull(model, usage) ?? 0;
  }

  /** USD for `usage` on `model`, `null` when its price is unknown. */
  costOrNull(model: string, usage: TokenUsageForCost): number | null {
    return this.pricer.cost(model, usage);
  }

  /** The cost of one call: what the provider reported, otherwise the price of `model`. */
  callCost(model: string, usage: ChatUsage): number {
    return usage.cost ?? this.cost(model, usage);
  }

  /**
   * Warns once per model when a call to `model` on `provider` reported no cost and nothing
   * prices it, so run costs and budgets count it as $0.
   */
  noteUnpriced(model: string, provider: string): void {
    if (this.warned.has(model)) return;
    this.warned.add(model);
    if (this.pricer.hasOverride(model) || this.pricing(model)) return;
    if (SELF_HOSTED_PROVIDERS.has(provider)) return;
    getLogger().warn(
      `No price is known for ${model}, so its calls count as $0 in run costs and budgets. Set its price per million tokens in llm.pricing (for example llm.pricing['${model}'] = { input: 0.5, output: 1.5 }), or load the current model catalogue with initializeModels() from @cogitator-ai/models at startup.`,
      { model, provider }
    );
  }
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

  constructor(
    private readonly pricer: CallPricer,
    saved?: RunCostState,
    tokensSoFar?: RunCostTokens
  ) {
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
    for (const [model, tokens] of this.byModel) usd += this.priced(model, tokens);
    return usd + this.priced(runModel, this.unattributed);
  }

  private priced(model: string, tokens: RunCostTokens): number {
    return tokens.inputTokens > 0 || tokens.outputTokens > 0 ? this.pricer.cost(model, tokens) : 0;
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
