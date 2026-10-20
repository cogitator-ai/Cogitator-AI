import type { ModelPricing } from './types';
import { costOf, getPricing, type TokenUsageForCost } from './registry';

/** Prices of your own, in USD per million tokens, by model: see {@link ModelPricer}. */
export type PricingOverrides = Record<string, ModelPricing>;

/**
 * Prices model calls: from prices of your own first, then from the model registry. A price of
 * your own is found by the model string a run uses or by its tail after any `/`, the longest
 * match first, case-insensitively: `openai/gpt-4o` prices only that model at OpenAI, `gpt-4o`
 * prices it at every provider that serves it under that name, `llama3.3:70b` prices it on Ollama.
 */
export class ModelPricer {
  private readonly overrides = new Map<string, ModelPricing>();

  constructor(
    overrides: PricingOverrides = {},
    private readonly registryPricing: (model: string) => ModelPricing | null = getPricing
  ) {
    for (const [model, pricing] of Object.entries(overrides)) {
      this.overrides.set(model.trim().toLowerCase(), pricing);
    }
  }

  /** The price of `model`: your own when one matches, otherwise the registry's, `null` when neither knows it. */
  pricing(model: string): ModelPricing | null {
    return this.override(model) ?? this.registryPricing(model);
  }

  /** Whether one of your own prices covers `model`. */
  hasOverride(model: string): boolean {
    return this.override(model) !== undefined;
  }

  /** Your own price of `model`, when one matches. */
  override(model: string): ModelPricing | undefined {
    if (this.overrides.size === 0) return undefined;
    let name = model.trim().toLowerCase();
    for (;;) {
      const pricing = this.overrides.get(name);
      if (pricing) return pricing;
      const slash = name.indexOf('/');
      if (slash === -1) return undefined;
      name = name.slice(slash + 1);
    }
  }

  /** Cost in USD of `usage` on `model`, `null` when its price is unknown. */
  cost(model: string, usage: TokenUsageForCost): number | null {
    const pricing = this.pricing(model);
    return pricing ? costOf(pricing, usage) : null;
  }
}
