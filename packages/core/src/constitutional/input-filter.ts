import type {
  GuardrailConfig,
  FilterResult,
  HarmScore,
  ConstitutionalPrinciple,
  Constitution,
  LLMBackend,
} from '@cogitator-ai/types';
import { buildInputEvaluationPrompt, parseEvaluationResponse } from './prompts';
import { filterPrinciplesByLayer } from './constitution';

export interface InputFilterOptions {
  llm: LLMBackend;
  config: GuardrailConfig;
  constitution: Constitution;
}

export class InputFilter {
  private llm: LLMBackend;
  private config: GuardrailConfig;
  private constitution: Constitution;
  private principles: ConstitutionalPrinciple[];

  constructor(options: InputFilterOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.constitution = options.constitution;
    this.principles = filterPrinciplesByLayer(this.constitution, 'input');
  }

  async filter(input: string, context?: string): Promise<FilterResult> {
    const quickResult = this.quickScan(input);
    if (!quickResult.allowed) {
      return quickResult;
    }

    if (this.principles.length === 0) {
      return { allowed: true, harmScores: [] };
    }

    const harmScores = await this.evaluateWithLLM(input, context);
    return this.applyThresholds(harmScores);
  }

  private quickScan(input: string): FilterResult {
    const lowered = input.toLowerCase();
    const patterns = [
      { pattern: /how\s+to\s+(make|build|create)\s+(a\s+)?bomb/i, category: 'violence' as const },
      { pattern: /how\s+to\s+kill\s+(myself|someone)/i, category: 'violence' as const },
      { pattern: /how\s+to\s+hack\s+(into|a)/i, category: 'illegal' as const },
      { pattern: /child\s+porn(ography)?/i, category: 'sexual' as const },
      { pattern: /ways\s+to\s+commit\s+suicide/i, category: 'self-harm' as const },
    ];

    for (const { pattern, category } of patterns) {
      if (pattern.test(lowered)) {
        return {
          allowed: false,
          harmScores: [
            {
              category,
              severity: 'high',
              confidence: 0.95,
              reasoning: 'Matched explicit harmful pattern',
            },
          ],
          blockedReason: `Input contains potentially harmful content (${category})`,
        };
      }
    }

    return { allowed: true, harmScores: [] };
  }

  private async evaluateWithLLM(input: string, _context?: string): Promise<HarmScore[]> {
    const prompt = buildInputEvaluationPrompt(input, this.principles);

    const response = await this.llm.chat({
      model: this.config.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 500,
    });

    const result = parseEvaluationResponse(response.content);
    return result.harmScores;
  }

  private applyThresholds(harmScores: HarmScore[]): FilterResult {
    const thresholds = this.config.thresholds;
    const severityOrder: Record<string, number> = { low: 1, medium: 2, high: 3 };

    const violations = harmScores.filter((score) => {
      const threshold = thresholds[score.category] ?? 'high';
      return severityOrder[score.severity] >= severityOrder[threshold];
    });

    if (violations.length === 0) {
      return { allowed: true, harmScores };
    }

    const categories = [...new Set(violations.map((v) => v.category))];
    return {
      allowed: false,
      harmScores,
      blockedReason: `Input violates safety policies: ${categories.join(', ')}`,
    };
  }

  updateConstitution(constitution: Constitution): void {
    this.constitution = constitution;
    this.principles = filterPrinciplesByLayer(constitution, 'input');
  }
}
