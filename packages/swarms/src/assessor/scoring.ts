import type { DiscoveredModel, RoleRequirements } from '@cogitator-ai/types';

export interface ScoredModel {
  model: DiscoveredModel;
  score: number;
  reasons: string[];
}

const ADVANCED_MODELS = [
  'gpt-4o',
  'gpt-4-turbo',
  'claude-3-opus',
  'claude-sonnet-4',
  'claude-3-5-sonnet',
  'gemini-1.5-pro',
  'llama3.1:70b',
  'llama3.2:70b',
  'qwen2.5:72b',
  'mixtral',
  'deepseek-r1',
];

const FAST_MODELS = [
  'gpt-4o-mini',
  'claude-3-5-haiku',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'llama3.2:1b',
  'llama3.2:3b',
  'phi3',
  'phi4',
  'qwen2.5:1.5b',
  'qwen2.5:3b',
];

const CODE_MODELS = [
  'claude-3-5-sonnet',
  'claude-sonnet-4',
  'gpt-4o',
  'codellama',
  'starcoder',
  'deepseek-coder',
  'qwen2.5-coder',
];

export class ModelScorer {
  score(model: DiscoveredModel, requirements: RoleRequirements): ScoredModel {
    let score = 100;
    const reasons: string[] = [];

    // Hard requirements - disqualify if not met
    if (requirements.needsVision && !model.capabilities.supportsVision) {
      return { model, score: 0, reasons: ['Does not support vision (required)'] };
    }

    if (requirements.needsToolCalling && !model.capabilities.supportsTools) {
      return { model, score: 0, reasons: ['Does not support tool calling (required)'] };
    }

    // Context window check
    if (requirements.needsLongContext && model.contextWindow < 32000) {
      score -= 30;
      reasons.push(`Limited context window (${model.contextWindow} tokens)`);
    } else if (model.contextWindow >= 100000) {
      score += 5;
      reasons.push('Large context window');
    }

    // Local model preference
    if (model.isLocal) {
      score += 15;
      reasons.push('Local model (no API cost)');
    }

    // Cost sensitivity
    if (!model.isLocal) {
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

    // Reasoning level
    const isAdvanced = this.isAdvancedModel(model);
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

    // Speed preference
    const isFast = this.isFastModel(model);
    if (requirements.needsSpeed === 'fast') {
      if (isFast || model.isLocal) {
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

    // Domain matching
    if (requirements.domains?.includes('code')) {
      if (this.isCodeModel(model)) {
        score += 10;
        reasons.push('Strong coding capability');
      }
    }

    // Complexity matching
    if (requirements.complexity === 'complex' && isAdvanced) {
      score += 10;
      reasons.push('Suitable for complex tasks');
    } else if (requirements.complexity === 'simple' && isFast) {
      score += 5;
      reasons.push('Efficient for simple tasks');
    }

    // Role-specific adjustments
    if (requirements.role === 'supervisor' && isAdvanced) {
      score += 10;
      reasons.push('Good for supervisory role');
    } else if (requirements.role === 'worker' && model.isLocal) {
      score += 5;
      reasons.push('Cost-effective for worker role');
    }

    return {
      model,
      score: Math.max(0, score),
      reasons,
    };
  }

  scoreAll(models: DiscoveredModel[], requirements: RoleRequirements): ScoredModel[] {
    return models
      .map((model) => this.score(model, requirements))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private isAdvancedModel(model: DiscoveredModel): boolean {
    const id = model.id.toLowerCase();
    return ADVANCED_MODELS.some((m) => id.includes(m.toLowerCase()));
  }

  private isFastModel(model: DiscoveredModel): boolean {
    const id = model.id.toLowerCase();
    return FAST_MODELS.some((m) => id.includes(m.toLowerCase()));
  }

  private isCodeModel(model: DiscoveredModel): boolean {
    const id = model.id.toLowerCase();
    return CODE_MODELS.some((m) => id.includes(m.toLowerCase()));
  }
}
