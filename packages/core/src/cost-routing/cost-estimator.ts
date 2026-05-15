import type {
  CostEstimate,
  CostBreakdown,
  EstimateOptions,
  TokenEstimate,
  TaskComplexity,
  ToolSchema,
} from '@cogitator-ai/types';
import { getModelRegistry } from '@cogitator-ai/models';
import type { Agent } from '../agent';
import { TaskAnalyzer } from './task-analyzer';
import { TokenEstimator } from './token-estimator';
import { parseModel } from '../llm/index';

const DEFAULT_PRICING = { input: 0.15, output: 0.6 };

const LOCAL_PROVIDER_PREFIXES = ['ollama/'];

export class CostEstimator {
  private taskAnalyzer: TaskAnalyzer;
  private tokenEstimator: TokenEstimator;

  constructor() {
    this.taskAnalyzer = new TaskAnalyzer();
    this.tokenEstimator = new TokenEstimator();
  }

  async estimate(params: {
    agent: Agent;
    input: string;
    options?: EstimateOptions;
  }): Promise<CostEstimate> {
    const { agent, input, options = {} } = params;
    const warnings: string[] = [];

    const parsed = parseModel(agent.model);
    const modelId = parsed.model;
    const provider = parsed.provider ?? 'unknown';
    const isLocal = this.isLocalModel(agent.model);

    if (isLocal) {
      return this.createLocalModelEstimate(modelId, provider, warnings);
    }

    const registry = getModelRegistry();
    await registry.initialize();

    const modelInfo = registry.getModel(modelId);
    const pricing = modelInfo?.pricing ?? null;

    if (!pricing) {
      warnings.push('Model pricing not available, using estimates');
    }

    const inputPrice = pricing?.input ?? DEFAULT_PRICING.input;
    const outputPrice = pricing?.output ?? DEFAULT_PRICING.output;

    const requirements = this.taskAnalyzer.analyze(input);
    const complexity = requirements.complexity ?? 'moderate';

    const hasTools = agent.tools !== undefined && agent.tools.length > 0;
    const toolCount = agent.tools?.length ?? 0;

    const iterations =
      options.assumeIterations ?? this.tokenEstimator.estimateIterations(complexity, hasTools);

    const toolCalls =
      options.assumeToolCalls ?? this.tokenEstimator.estimateToolCalls(complexity, toolCount);

    const toolSchemas: ToolSchema[] | undefined = hasTools
      ? agent.tools!.map((t) => t.toJSON())
      : undefined;

    const inputTokens = this.tokenEstimator.estimateInputTokens({
      systemPrompt: agent.instructions ?? '',
      userInput: input,
      toolSchemas,
      iterations,
      includeMemory: options.includeMemory ?? true,
      memoryTokenEstimate: options.memoryTokenEstimate,
    });

    const outputTokens = this.tokenEstimator.estimateOutputTokens({
      complexity,
      hasTools,
      toolCallCount: toolCalls,
      iterations,
    });

    const {
      min: minInputCost,
      max: maxInputCost,
      expected: expectedInputCost,
    } = this.calculateCost(inputTokens, inputPrice);
    const {
      min: minOutputCost,
      max: maxOutputCost,
      expected: expectedOutputCost,
    } = this.calculateCost(outputTokens, outputPrice);

    const minCost = minInputCost + minOutputCost;
    const maxCost = maxInputCost + maxOutputCost;
    const expectedCost = expectedInputCost + expectedOutputCost;

    const confidence = this.calculateConfidence(complexity, hasTools, pricing !== null, toolCalls);

    if (complexity === 'complex') {
      warnings.push('Complex task may require more iterations than estimated');
    }
    if (toolCalls > 3) {
      warnings.push('Tool calls are unpredictable, actual cost may vary significantly');
    }
    if (options.includeMemory !== false && !options.memoryTokenEstimate) {
      warnings.push('Memory context estimation is approximate');
    }

    const breakdown: CostBreakdown = {
      inputTokens,
      outputTokens,
      model: modelId,
      provider,
      pricePerMInputTokens: inputPrice,
      pricePerMOutputTokens: outputPrice,
      iterationCount: iterations,
      toolCallCount: toolCalls,
    };

    return {
      minCost: this.round(minCost),
      maxCost: this.round(maxCost),
      expectedCost: this.round(expectedCost),
      confidence,
      breakdown,
      warnings,
    };
  }

  private calculateCost(
    tokens: TokenEstimate,
    pricePerMillion: number
  ): { min: number; max: number; expected: number } {
    return {
      min: (tokens.min * pricePerMillion) / 1_000_000,
      max: (tokens.max * pricePerMillion) / 1_000_000,
      expected: (tokens.expected * pricePerMillion) / 1_000_000,
    };
  }

  private calculateConfidence(
    complexity: TaskComplexity,
    hasTools: boolean,
    hasPricing: boolean,
    toolCalls: number
  ): number {
    let confidence = 0.9;

    if (!hasPricing) confidence -= 0.3;
    if (complexity === 'moderate') confidence -= 0.1;
    if (complexity === 'complex') confidence -= 0.25;
    if (hasTools) confidence -= 0.1;
    if (toolCalls > 3) confidence -= 0.1;

    return Math.max(0.2, Math.min(0.95, confidence));
  }

  private isLocalModel(model: string): boolean {
    const lower = model.toLowerCase();
    return LOCAL_PROVIDER_PREFIXES.some((p) => lower.startsWith(p));
  }

  private createLocalModelEstimate(
    model: string,
    provider: string,
    warnings: string[]
  ): CostEstimate {
    warnings.push('Local model (Ollama) - no API cost');

    return {
      minCost: 0,
      maxCost: 0,
      expectedCost: 0,
      confidence: 1.0,
      breakdown: {
        inputTokens: { min: 0, max: 0, expected: 0 },
        outputTokens: { min: 0, max: 0, expected: 0 },
        model,
        provider: provider || 'ollama',
        pricePerMInputTokens: 0,
        pricePerMOutputTokens: 0,
        iterationCount: 0,
        toolCallCount: 0,
      },
      warnings,
    };
  }

  private round(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }
}
