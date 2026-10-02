import { createHash } from 'node:crypto';
import type {
  Tool,
  LLMBackend,
  CapabilityGap,
  GapAnalysisResult,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import { buildGapAnalysisPrompt, parseGapAnalysisResponse } from './prompts';
import { llmChat } from '../utils/llm-helper';

export interface GapAnalyzerOptions {
  llm: LLMBackend;
  config: ToolSelfGenerationConfig;
  model?: string;
}

export class GapAnalyzer {
  private readonly llm: LLMBackend;
  private readonly config: ToolSelfGenerationConfig;
  private readonly model: string;
  private readonly analysisCache = new Map<string, GapAnalysisResult>();

  constructor(options: GapAnalyzerOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.model = options.model ?? 'default';
  }

  async analyze(
    userIntent: string,
    availableTools: Tool[],
    context?: {
      failedAttempts?: string[];
      previousGaps?: CapabilityGap[];
    }
  ): Promise<GapAnalysisResult> {
    const cacheKey = this.buildCacheKey(userIntent, availableTools, context);
    const cached = this.analysisCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp.getTime() < 60000) {
      return cached;
    }

    const toolSummaries = availableTools.map((t) => ({
      name: t.name,
      description: t.description,
    }));

    const prompt = buildGapAnalysisPrompt(userIntent, toolSummaries, context?.failedAttempts);

    const content = await llmChat(
      this.llm,
      [
        {
          role: 'system',
          content: `You are a capability analyzer for AI agents.
Identify gaps between user intent and available tools.
Be conservative - only report gaps when truly necessary.
Consider tool composition before suggesting new tools.`,
        },
        { role: 'user', content: prompt },
      ],
      { model: this.model, temperature: 0.3 }
    );

    const parsed = parseGapAnalysisResponse(content);
    const filteredGaps = this.filterAndPrioritizeGaps(
      parsed.gaps,
      availableTools,
      context?.previousGaps
    );

    const result: GapAnalysisResult = {
      gaps: filteredGaps,
      analysis: {
        intentCoverage: this.calculateCoverage(userIntent, availableTools, filteredGaps),
        suggestedCompositions: this.suggestCompositions(userIntent, availableTools),
        canProceedWithExisting: parsed.canProceed && filteredGaps.length === 0,
        reasoning: parsed.alternativeApproach || this.generateReasoning(filteredGaps),
      },
      timestamp: new Date(),
    };

    this.analysisCache.set(cacheKey, result);

    if (this.analysisCache.size > 100) {
      const oldest = Array.from(this.analysisCache.entries())
        .sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime())
        .slice(0, 20);
      oldest.forEach(([key]) => this.analysisCache.delete(key));
    }

    return result;
  }

  private filterAndPrioritizeGaps(
    gaps: CapabilityGap[],
    availableTools: Tool[],
    previousGaps?: CapabilityGap[]
  ): CapabilityGap[] {
    const toolNames = new Set(availableTools.map((t) => t.name.toLowerCase()));
    const previousGapIds = new Set(previousGaps?.map((g) => g.id) || []);

    return gaps
      .filter((gap) => {
        if (toolNames.has(gap.suggestedToolName.toLowerCase())) {
          return false;
        }

        if (gap.confidence < this.config.minConfidenceForGeneration) {
          return false;
        }

        const complexityAllowed = this.isComplexityAllowed(gap.complexity);
        if (!complexityAllowed) {
          return false;
        }

        return true;
      })
      .map((gap) => ({
        ...gap,
        priority: this.calculatePriority(gap, previousGapIds.has(gap.id)),
      }))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, this.config.maxToolsPerSession);
  }

  private isComplexityAllowed(complexity: 'simple' | 'moderate' | 'complex'): boolean {
    const maxComplexity = this.config.maxComplexity || 'moderate';
    const levels = { simple: 1, moderate: 2, complex: 3 };
    return levels[complexity] <= levels[maxComplexity];
  }

  private calculatePriority(gap: CapabilityGap, isPreviouslyIdentified: boolean): number {
    let priority = gap.confidence;

    if (isPreviouslyIdentified) {
      priority += 0.2;
    }

    const complexityBonus = { simple: 0.1, moderate: 0, complex: -0.1 };
    priority += complexityBonus[gap.complexity];

    return Math.min(1, Math.max(0, priority));
  }

  private calculateCoverage(
    userIntent: string,
    availableTools: Tool[],
    gaps: CapabilityGap[]
  ): number {
    if (gaps.length === 0) {
      return 1.0;
    }

    const toolDescriptionWords = availableTools
      .map((t) => t.description.toLowerCase().split(/\s+/))
      .flat();

    const intentTokens = new Set(userIntent.toLowerCase().split(/\s+/));
    let matchedTokens = 0;

    intentTokens.forEach((token) => {
      if (token.length > 3 && toolDescriptionWords.includes(token)) {
        matchedTokens++;
      }
    });

    const baseCoverage = matchedTokens / Math.max(1, intentTokens.size);
    const gapPenalty = gaps.reduce((sum, g) => sum + g.confidence * 0.2, 0);

    return Math.max(0, Math.min(1, baseCoverage - gapPenalty));
  }

  private suggestCompositions(
    userIntent: string,
    availableTools: Tool[]
  ): Array<{ tools: string[]; description: string }> {
    const compositions: Array<{ tools: string[]; description: string }> = [];

    const intentLower = userIntent.toLowerCase();

    const keywords = {
      transform: ['parse', 'format', 'convert'],
      analyze: ['calculate', 'validate', 'check'],
      combine: ['merge', 'join', 'aggregate'],
    };

    for (const [action, related] of Object.entries(keywords)) {
      if (intentLower.includes(action)) {
        const relatedTools = availableTools.filter((t) =>
          related.some(
            (r) => t.name.toLowerCase().includes(r) || t.description.toLowerCase().includes(r)
          )
        );

        if (relatedTools.length >= 2) {
          compositions.push({
            tools: relatedTools.slice(0, 3).map((t) => t.name),
            description: `Combine ${relatedTools.map((t) => t.name).join(' + ')} for ${action}`,
          });
        }
      }
    }

    return compositions.slice(0, 3);
  }

  private generateReasoning(gaps: CapabilityGap[]): string {
    if (gaps.length === 0) {
      return 'All required capabilities are available with existing tools.';
    }

    const gapDescriptions = gaps
      .map((g) => `- ${g.description} (confidence: ${(g.confidence * 100).toFixed(0)}%)`)
      .join('\n');

    return `Identified ${gaps.length} capability gap(s):\n${gapDescriptions}`;
  }

  private buildCacheKey(
    userIntent: string,
    tools: Tool[],
    context?: { failedAttempts?: string[]; previousGaps?: CapabilityGap[] }
  ): string {
    const toolSignature = tools
      .map((t) => `${t.name}:${t.description}`)
      .sort()
      .join('\n');
    const raw = JSON.stringify([
      userIntent,
      toolSignature,
      context?.failedAttempts ?? [],
      (context?.previousGaps ?? []).map((g) => g.id).sort(),
    ]);
    return createHash('sha256').update(raw).digest('hex');
  }

  clearCache(): void {
    this.analysisCache.clear();
  }
}
