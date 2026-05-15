import type {
  GuardrailConfig,
  FilterResult,
  HarmScore,
  ConstitutionalPrinciple,
  Constitution,
  LLMBackend,
  Message,
} from '@cogitator-ai/types';
import { buildOutputEvaluationPrompt, parseEvaluationResponse } from './prompts';
import { filterPrinciplesByLayer } from './constitution';

export interface OutputFilterOptions {
  llm: LLMBackend;
  config: GuardrailConfig;
  constitution: Constitution;
}

export class OutputFilter {
  private llm: LLMBackend;
  private config: GuardrailConfig;
  private constitution: Constitution;
  private principles: ConstitutionalPrinciple[];

  constructor(options: OutputFilterOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.constitution = options.constitution;
    this.principles = filterPrinciplesByLayer(this.constitution, 'output');
  }

  async filter(output: string, context: Message[]): Promise<FilterResult> {
    const quickResult = this.quickScan(output);
    if (!quickResult.allowed) {
      return quickResult;
    }

    if (this.principles.length === 0) {
      return { allowed: true, harmScores: [] };
    }

    const harmScores = await this.evaluateWithLLM(output, context);
    return this.applyThresholds(harmScores);
  }

  private quickScan(output: string): FilterResult {
    const lowered = output.toLowerCase();

    const patterns = [
      { pattern: /rm\s+-rf\s+\/(?!\w)/i, category: 'illegal' as const },
      { pattern: /format\s+c:/i, category: 'illegal' as const },
      { pattern: /sudo\s+rm\s+-rf/i, category: 'illegal' as const },
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
              reasoning: 'Contains dangerous system command',
            },
          ],
          blockedReason: 'Output contains potentially dangerous commands',
        };
      }
    }

    return { allowed: true, harmScores: [] };
  }

  private async evaluateWithLLM(output: string, context: Message[]): Promise<HarmScore[]> {
    const prompt = buildOutputEvaluationPrompt(output, context, this.principles);

    const response = await this.llm.chat({
      model: this.config.model ?? 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 500,
    });

    const result = parseEvaluationResponse(response.content);
    if (result.isHarmful && result.harmScores.length === 0) {
      return [
        {
          category: 'manipulation',
          severity: 'high',
          confidence: 1,
          reasoning: 'Safety evaluator marked output as harmful without category details',
        },
      ];
    }
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
      blockedReason: `Output violates safety policies: ${categories.join(', ')}`,
    };
  }

  updateConstitution(constitution: Constitution): void {
    this.constitution = constitution;
    this.principles = filterPrinciplesByLayer(constitution, 'output');
  }
}
