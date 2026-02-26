import type {
  LLMBackend,
  Insight,
  InsightStore,
  Reflection,
  ReflectionConfig,
  ReflectionAction,
  ReflectionResult,
  AgentContext,
  ReflectionSummary,
  InsightType,
} from '@cogitator-ai/types';
import {
  buildToolReflectionPrompt,
  buildErrorReflectionPrompt,
  buildRunReflectionPrompt,
  parseReflectionResponse,
} from './prompts';

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface ReflectionEngineOptions {
  llm: LLMBackend;
  insightStore: InsightStore;
  config: ReflectionConfig;
}

const MAX_REFLECTION_RUNS = 100;

export class ReflectionEngine {
  private llm: LLMBackend;
  private insightStore: InsightStore;
  private config: ReflectionConfig;
  private reflections = new Map<string, Reflection[]>();

  constructor(options: ReflectionEngineOptions) {
    this.llm = options.llm;
    this.insightStore = options.insightStore;
    this.config = options.config;
  }

  async reflectOnToolCall(
    action: ReflectionAction,
    context: AgentContext
  ): Promise<ReflectionResult> {
    const relevantInsights = await this.insightStore.findRelevant(context.agentId, context.goal, 5);

    const prompt = buildToolReflectionPrompt(action, context, relevantInsights);
    const response = await this.callLLM(prompt);
    const parsed = parseReflectionResponse(response);

    if (!parsed) {
      return this.createFallbackResult(action, context);
    }

    const reflection = this.createReflection(action, context, parsed);
    await this.processReflection(reflection, context);

    return {
      reflection,
      shouldAdjustStrategy: parsed.confidence < 0.5,
      suggestedAction: parsed.whatCouldImprove ?? undefined,
    };
  }

  async reflectOnError(action: ReflectionAction, context: AgentContext): Promise<ReflectionResult> {
    const relevantInsights = await this.insightStore.findRelevant(
      context.agentId,
      `error ${action.error ?? ''}`,
      5
    );

    const prompt = buildErrorReflectionPrompt(action, context, relevantInsights);
    const response = await this.callLLM(prompt);
    const parsed = parseReflectionResponse(response);

    if (!parsed) {
      return this.createFallbackResult(action, context, true);
    }

    const reflection = this.createReflection(action, context, parsed);
    await this.processReflection(reflection, context);

    return {
      reflection,
      shouldAdjustStrategy: true,
      suggestedAction: parsed.whatCouldImprove ?? 'Consider alternative approaches',
    };
  }

  async reflectOnRun(
    context: AgentContext,
    actions: ReflectionAction[],
    finalOutput: string,
    success: boolean
  ): Promise<ReflectionResult> {
    const prompt = buildRunReflectionPrompt(context, actions, finalOutput, success);
    const response = await this.callLLM(prompt);
    const parsed = parseReflectionResponse(response);

    const action: ReflectionAction = {
      type: 'response',
      output: finalOutput,
    };

    if (!parsed) {
      return this.createFallbackResult(action, context, !success);
    }

    const reflection = this.createReflection(action, context, parsed);
    await this.processReflection(reflection, context);

    return {
      reflection,
      shouldAdjustStrategy: false,
      suggestedAction: parsed.whatCouldImprove ?? undefined,
    };
  }

  async getRelevantInsights(context: AgentContext, limit = 5): Promise<Insight[]> {
    const insights = await this.insightStore.findRelevant(context.agentId, context.goal, limit);

    for (const insight of insights) {
      await this.insightStore.markUsed(insight.id);
    }

    return insights;
  }

  getRunReflections(runId: string): Reflection[] {
    return this.reflections.get(runId) ?? [];
  }

  async getSummary(agentId: string): Promise<ReflectionSummary> {
    const allInsights = await this.insightStore.getAll(agentId);

    let allReflections: Reflection[] = [];
    for (const reflections of this.reflections.values()) {
      allReflections = allReflections.concat(reflections.filter((r) => r.agentId === agentId));
    }

    const successCount = allReflections.filter((r) => r.analysis.wasSuccessful).length;
    const totalConfidence = allReflections.reduce((sum, r) => sum + r.analysis.confidence, 0);

    const mistakes = allInsights.filter((i) => i.type === 'mistake').map((i) => i.content);

    const patterns = allInsights
      .filter((i) => i.type === 'pattern' || i.type === 'success')
      .map((i) => i.content);

    const topInsights = [...allInsights]
      .sort((a, b) => b.usageCount * b.confidence - a.usageCount * a.confidence)
      .slice(0, 10);

    return {
      totalReflections: allReflections.length,
      successRate: allReflections.length > 0 ? successCount / allReflections.length : 0,
      averageConfidence: allReflections.length > 0 ? totalConfidence / allReflections.length : 0,
      topInsights,
      commonMistakes: [...new Set(mistakes)].slice(0, 5),
      learnedPatterns: [...new Set(patterns)].slice(0, 5),
    };
  }

  private async callLLM(prompt: string): Promise<string> {
    const model = this.config.reflectionModel;
    if (!model) {
      throw new Error('ReflectionEngine requires a reflectionModel to be configured');
    }

    const response = await this.llm.chat({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a reflection assistant. Analyze actions and extract learnings. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      maxTokens: 1000,
    });

    return response.content;
  }

  private createReflection(
    action: ReflectionAction,
    context: AgentContext,
    parsed: {
      wasSuccessful: boolean;
      confidence: number;
      reasoning: string;
      alternativesConsidered?: string[];
      whatCouldImprove?: string;
      insights: Array<{ type: string; content: string; context: string }>;
    }
  ): Reflection {
    const reflectionId = generateId();

    const insights: Insight[] = parsed.insights.map((i) => ({
      id: generateId(),
      type: this.validateInsightType(i.type),
      content: i.content,
      context: i.context,
      confidence: parsed.confidence,
      usageCount: 0,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      agentId: context.agentId,
      source: {
        runId: context.runId,
        reflectionId,
      },
    }));

    return {
      id: reflectionId,
      runId: context.runId,
      agentId: context.agentId,
      timestamp: new Date(),
      action,
      analysis: {
        wasSuccessful: parsed.wasSuccessful,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
        alternativesConsidered: parsed.alternativesConsidered,
        whatCouldImprove: parsed.whatCouldImprove,
      },
      insights,
      goal: context.goal,
      iterationIndex: context.iterationIndex,
    };
  }

  private async processReflection(reflection: Reflection, context: AgentContext): Promise<void> {
    let runReflections = this.reflections.get(reflection.runId);
    if (!runReflections) {
      runReflections = [];
      this.reflections.set(reflection.runId, runReflections);
    }
    runReflections.push(reflection);

    if (this.reflections.size > MAX_REFLECTION_RUNS) {
      const oldestKey = this.reflections.keys().next().value!;
      this.reflections.delete(oldestKey);
    }

    if (this.config.storeInsights !== false) {
      const minConfidence = this.config.minConfidenceToStore ?? 0.3;
      const valuableInsights = reflection.insights.filter((i) => i.confidence >= minConfidence);

      if (valuableInsights.length > 0) {
        await this.insightStore.storeMany(valuableInsights);

        const maxInsights = this.config.maxInsightsPerAgent ?? 100;
        await this.insightStore.prune(context.agentId, maxInsights);
      }
    }
  }

  private createFallbackResult(
    action: ReflectionAction,
    context: AgentContext,
    isError = false
  ): ReflectionResult {
    const reflection: Reflection = {
      id: generateId(),
      runId: context.runId,
      agentId: context.agentId,
      timestamp: new Date(),
      action,
      analysis: {
        wasSuccessful: !isError,
        confidence: 0.5,
        reasoning: isError ? 'Error occurred during execution' : 'Action completed',
        alternativesConsidered: [],
        whatCouldImprove: undefined,
      },
      insights: [],
      goal: context.goal,
      iterationIndex: context.iterationIndex,
    };

    return {
      reflection,
      shouldAdjustStrategy: isError,
      suggestedAction: undefined,
    };
  }

  private validateInsightType(type: string): InsightType {
    const validTypes: InsightType[] = ['pattern', 'mistake', 'success', 'tip', 'warning'];
    if (validTypes.includes(type as InsightType)) {
      return type as InsightType;
    }
    return 'tip';
  }
}
