import type { TaskRequirements, ModelRecommendation, CostRoutingConfig } from '@cogitator-ai/types';
import { getModelRegistry, type ModelInfo } from '@cogitator-ai/models';

const ADVANCED_MODELS = [
  'gpt-4.1',
  'gpt-4o',
  'o3',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'gemini-2.5-pro',
  'gemini-3-pro',
  'llama3.3:70b',
  'qwen2.5:72b',
  'mixtral',
  'deepseek-r1',
];

const FAST_MODELS = [
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o-mini',
  'o4-mini',
  'o3-mini',
  'claude-haiku-4-5',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-flash',
  'llama3.1:8b',
  'phi4',
  'qwen2.5:1.5b',
  'qwen2.5:3b',
];

const CODE_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'gpt-4.1',
  'gpt-4o',
  'codellama',
  'deepseek-coder',
  'qwen2.5-coder',
];

interface ScoredModel {
  model: ModelInfo;
  score: number;
  reasons: string[];
}

export class ModelSelector {
  private config: CostRoutingConfig;

  constructor(config: CostRoutingConfig) {
    this.config = config;
  }

  async selectModel(requirements: TaskRequirements): Promise<ModelRecommendation> {
    const registry = getModelRegistry();
    await registry.initialize();

    const candidates = registry.listModels({
      supportsTools: requirements.needsToolCalling ? true : undefined,
      supportsVision: requirements.needsVision ? true : undefined,
      minContextWindow: requirements.needsLongContext ? 32000 : undefined,
      excludeDeprecated: true,
    });

    if (candidates.length === 0) {
      return this.fallbackRecommendation();
    }

    const scored = candidates
      .map((m) => this.scoreModel(m, requirements))
      .filter((s) => s.score >= (this.config.minCapabilityMatch ?? 0.3) * 100)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return this.fallbackRecommendation();
    }

    if (this.config.preferLocal) {
      const local = scored.find((s) => this.isLocalModel(s.model.id));
      if (local && local.score >= scored[0].score * 0.8) {
        return this.toRecommendation(local, scored, requirements);
      }
    }

    return this.toRecommendation(scored[0], scored, requirements);
  }

  private scoreModel(model: ModelInfo, requirements: TaskRequirements): ScoredModel {
    let score = 100;
    const reasons: string[] = [];

    if (requirements.needsVision && !model.capabilities?.supportsVision) {
      return { model, score: 0, reasons: ['Does not support vision (required)'] };
    }

    if (requirements.needsToolCalling && !model.capabilities?.supportsTools) {
      return { model, score: 0, reasons: ['Does not support tool calling (required)'] };
    }

    if (requirements.needsLongContext && model.contextWindow < 32000) {
      score -= 30;
      reasons.push(`Limited context window (${model.contextWindow} tokens)`);
    } else if (model.contextWindow >= 100000) {
      score += 5;
      reasons.push('Large context window');
    }

    const isLocal = this.isLocalModel(model.id);
    if (isLocal) {
      score += 15;
      reasons.push('Local model (no API cost)');
    }

    if (!isLocal) {
      const avgCost = (model.pricing.input + model.pricing.output) / 2;
      if (requirements.costSensitivity === 'high') {
        if (avgCost > 10) {
          score -= 25;
          reasons.push('High cost model');
        } else if (avgCost < 1) {
          score += 10;
          reasons.push('Cost-effective');
        }
      } else if (requirements.costSensitivity === 'low' && avgCost > 10) {
        score += 5;
        reasons.push('Premium model (quality prioritized)');
      }
    }

    const isAdvanced = this.isAdvancedModel(model.id);
    if (requirements.needsReasoning === 'advanced') {
      if (isAdvanced) {
        score += 15;
        reasons.push('Strong reasoning capability');
      } else {
        score -= 20;
        reasons.push('May lack advanced reasoning');
      }
    } else if (requirements.needsReasoning === 'basic' && !isAdvanced) {
      score += 5;
      reasons.push('Appropriate for basic tasks');
    }

    const isFast = this.isFastModel(model.id);
    if (requirements.needsSpeed === 'fast') {
      if (isFast || isLocal) {
        score += 10;
        reasons.push('Fast response time');
      } else {
        score -= 10;
        reasons.push('May be slower');
      }
    } else if (requirements.needsSpeed === 'slow-ok' && isAdvanced) {
      score += 5;
      reasons.push('Quality over speed');
    }

    if (requirements.domains?.includes('code')) {
      if (this.isCodeModel(model.id)) {
        score += 10;
        reasons.push('Strong coding capability');
      }
    }

    if (requirements.complexity === 'complex' && isAdvanced) {
      score += 10;
      reasons.push('Suitable for complex tasks');
    } else if (requirements.complexity === 'simple' && isFast) {
      score += 5;
      reasons.push('Efficient for simple tasks');
    }

    return {
      model,
      score: Math.max(0, score),
      reasons,
    };
  }

  private toRecommendation(
    scored: ScoredModel,
    allScored: ScoredModel[],
    requirements: TaskRequirements
  ): ModelRecommendation {
    const fallbacks = allScored
      .filter((s) => s.model.id !== scored.model.id)
      .slice(0, 3)
      .map((s) => s.model.id);

    return {
      modelId: scored.model.id,
      provider: scored.model.provider,
      score: scored.score,
      reasons: scored.reasons,
      estimatedCost: this.estimateCost(scored.model, requirements.complexity ?? 'moderate'),
      fallbacks,
    };
  }

  private estimateCost(model: ModelInfo, complexity: 'simple' | 'moderate' | 'complex'): number {
    const tokenEstimates = {
      simple: { input: 500, output: 200 },
      moderate: { input: 2000, output: 1000 },
      complex: { input: 8000, output: 4000 },
    };

    const estimate = tokenEstimates[complexity];
    const inputCost = (model.pricing.input * estimate.input) / 1_000_000;
    const outputCost = (model.pricing.output * estimate.output) / 1_000_000;

    return inputCost + outputCost;
  }

  private fallbackRecommendation(): ModelRecommendation {
    return {
      modelId: 'gpt-4o-mini',
      provider: 'openai',
      score: 50,
      reasons: ['Fallback model - no suitable candidates found'],
      estimatedCost: 0.0005,
      fallbacks: ['claude-haiku-4-5', 'gemini-2.5-flash'],
    };
  }

  private isLocalModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return (
      lower.includes('ollama') ||
      lower.includes('llama') ||
      lower.includes('phi') ||
      lower.includes('qwen') ||
      lower.includes('mixtral') ||
      lower.includes('codellama') ||
      lower.includes('deepseek') ||
      lower.includes('gemma')
    );
  }

  private isAdvancedModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return ADVANCED_MODELS.some((m) => lower.includes(m.toLowerCase()));
  }

  private isFastModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return FAST_MODELS.some((m) => lower.includes(m.toLowerCase()));
  }

  private isCodeModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return CODE_MODELS.some((m) => lower.includes(m.toLowerCase()));
  }
}
