import type {
  LLMBackend,
  TaskProfile,
  ArchitectureConfig,
  EvolutionCandidate,
  ArchitectureEvolutionConfig,
  EvolutionMetrics,
} from '@cogitator-ai/types';
import { CapabilityAnalyzer } from './capability-analyzer';
import { EvolutionStrategy, type SelectionResult } from './evolution-strategy';
import {
  buildCandidateGenerationPrompt,
  buildPerformanceAnalysisPrompt,
  parseCandidateGenerationResponse,
  parsePerformanceAnalysisResponse,
} from './prompts';

export interface ParameterOptimizerOptions {
  llm: LLMBackend;
  config: ArchitectureEvolutionConfig;
  baseConfig: ArchitectureConfig;
}

export interface OptimizationResult {
  recommendedConfig: ArchitectureConfig;
  candidate: EvolutionCandidate | null;
  metrics: EvolutionMetrics;
  shouldAdopt: boolean;
  confidence: number;
  reasoning: string;
}

interface HistoricalRecord {
  taskProfile: TaskProfile;
  config: Partial<ArchitectureConfig>;
  score: number;
  metrics: Record<string, number>;
  timestamp: number;
}

export class ParameterOptimizer {
  private readonly llm: LLMBackend;
  private readonly config: ArchitectureEvolutionConfig;
  private readonly baseConfig: ArchitectureConfig;
  private readonly capabilityAnalyzer: CapabilityAnalyzer;
  private readonly evolutionStrategy: EvolutionStrategy;

  private candidates: EvolutionCandidate[] = [];
  private history: HistoricalRecord[] = [];
  private currentGeneration = 0;
  private readonly maxHistorySize = 100;

  constructor(options: ParameterOptimizerOptions) {
    this.llm = options.llm;
    this.config = options.config;
    this.baseConfig = options.baseConfig;

    this.capabilityAnalyzer = new CapabilityAnalyzer({
      llm: options.llm,
      enableLLMAnalysis: true,
    });

    this.evolutionStrategy = new EvolutionStrategy({
      strategy: options.config.strategy,
      explorationBonus: 2.0,
    });
  }

  async optimize(taskDescription: string): Promise<OptimizationResult> {
    const profile = await this.capabilityAnalyzer.analyzeTask(taskDescription);

    if (this.candidates.length === 0) {
      await this.generateInitialCandidates(profile);
    }

    const selection = this.evolutionStrategy.select(this.candidates);

    const mergedConfig = this.mergeConfigs(this.baseConfig, selection.candidate.config);

    return {
      recommendedConfig: mergedConfig,
      candidate: selection.candidate,
      metrics: this.calculateMetrics(),
      shouldAdopt: true,
      confidence: selection.score,
      reasoning: selection.reasoning,
    };
  }

  async recordOutcome(
    candidateId: string,
    taskProfile: TaskProfile,
    metrics: {
      successRate: number;
      latency: number;
      tokenUsage: number;
      qualityScore: number;
    }
  ): Promise<void> {
    const candidate = this.candidates.find((c) => c.id === candidateId);
    if (!candidate) return;

    const reward = this.calculateReward(metrics);
    this.evolutionStrategy.updateCandidate(candidate, reward);

    this.history.push({
      taskProfile,
      config: candidate.config,
      score: reward,
      metrics: {
        successRate: metrics.successRate,
        latency: metrics.latency,
        tokenUsage: metrics.tokenUsage,
        qualityScore: metrics.qualityScore,
      },
      timestamp: Date.now(),
    });

    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }

    if (this.shouldEvolve()) {
      await this.evolve(taskProfile);
    }
  }

  private async generateInitialCandidates(profile: TaskProfile): Promise<void> {
    const prompt = buildCandidateGenerationPrompt(
      profile,
      this.baseConfig,
      this.getRelevantHistory(profile)
    );

    try {
      const response = await this.callLLM(
        [
          {
            role: 'system',
            content: 'You are an AI architecture optimizer. Generate candidate configurations.',
          },
          { role: 'user', content: prompt },
        ],
        0.5
      );

      const generated = parseCandidateGenerationResponse(response.content);

      this.candidates = [
        this.createBaselineCandidate(),
        ...generated.map((c) => ({
          ...c,
          generation: this.currentGeneration,
        })),
      ];
    } catch {
      this.candidates = [this.createBaselineCandidate()];
    }
  }

  private createBaselineCandidate(): EvolutionCandidate {
    return {
      id: 'baseline',
      config: {},
      reasoning: 'Baseline configuration with no modifications',
      expectedImprovement: 0,
      risk: 'low',
      generation: 0,
      score: 0.5,
      evaluationCount: 0,
    };
  }

  private async evolve(currentProfile: TaskProfile): Promise<void> {
    this.currentGeneration++;

    const topCandidates = [...this.candidates]
      .filter((c) => c.evaluationCount > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (topCandidates.length === 0) return;

    const newCandidates = await this.generateOffspring(topCandidates, currentProfile);

    const keepCount = Math.max(3, Math.floor(this.candidates.length * 0.5));
    const survivingCandidates = [...this.candidates]
      .sort((a, b) => {
        const scoreA = a.score + (a.evaluationCount > 0 ? 0 : 0.1);
        const scoreB = b.score + (b.evaluationCount > 0 ? 0 : 0.1);
        return scoreB - scoreA;
      })
      .slice(0, keepCount);

    this.candidates = [...survivingCandidates, ...newCandidates];

    const maxCandidates = this.config.maxCandidates ?? 10;
    if (this.candidates.length > maxCandidates) {
      this.candidates = this.candidates.slice(0, maxCandidates);
    }
  }

  private async generateOffspring(
    parents: EvolutionCandidate[],
    profile: TaskProfile
  ): Promise<EvolutionCandidate[]> {
    const offspring: EvolutionCandidate[] = [];

    for (const parent of parents) {
      const mutated = this.mutateConfig(parent.config);
      offspring.push({
        id: `gen${this.currentGeneration}_${offspring.length}`,
        config: mutated,
        reasoning: `Mutation of ${parent.id}`,
        expectedImprovement: parent.score * 0.9,
        risk: 'medium',
        generation: this.currentGeneration,
        score: 0,
        evaluationCount: 0,
      });
    }

    if (parents.length >= 2) {
      const crossed = this.crossover(parents[0].config, parents[1].config);
      offspring.push({
        id: `gen${this.currentGeneration}_crossover`,
        config: crossed,
        reasoning: `Crossover of ${parents[0].id} and ${parents[1].id}`,
        expectedImprovement: (parents[0].score + parents[1].score) / 2,
        risk: 'medium',
        generation: this.currentGeneration,
        score: 0,
        evaluationCount: 0,
      });
    }

    return offspring;
  }

  private mutateConfig(config: Partial<ArchitectureConfig>): Partial<ArchitectureConfig> {
    const mutated = { ...config };
    const mutationRate = 0.3;

    if (Math.random() < mutationRate && mutated.temperature !== undefined) {
      mutated.temperature = Math.max(
        0,
        Math.min(2, mutated.temperature + (Math.random() - 0.5) * 0.3)
      );
    }

    if (Math.random() < mutationRate && mutated.maxTokens !== undefined) {
      const delta = Math.floor((Math.random() - 0.5) * 1000);
      mutated.maxTokens = Math.max(100, Math.min(32000, mutated.maxTokens + delta));
    }

    if (Math.random() < mutationRate && mutated.reflectionDepth !== undefined) {
      mutated.reflectionDepth = Math.max(
        0,
        Math.min(5, mutated.reflectionDepth + Math.round(Math.random() * 2 - 1))
      );
    }

    return mutated;
  }

  private crossover(
    configA: Partial<ArchitectureConfig>,
    configB: Partial<ArchitectureConfig>
  ): Partial<ArchitectureConfig> {
    const result: Partial<ArchitectureConfig> = {};

    const allKeys = new Set([...Object.keys(configA), ...Object.keys(configB)]);

    for (const key of allKeys) {
      const typedKey = key as keyof ArchitectureConfig;
      if (Math.random() < 0.5 && configA[typedKey] !== undefined) {
        (result as Record<string, unknown>)[key] = configA[typedKey];
      } else if (configB[typedKey] !== undefined) {
        (result as Record<string, unknown>)[key] = configB[typedKey];
      }
    }

    return result;
  }

  private calculateReward(metrics: {
    successRate: number;
    latency: number;
    tokenUsage: number;
    qualityScore: number;
  }): number {
    const weights = {
      success: 0.4,
      quality: 0.3,
      latency: 0.15,
      tokens: 0.15,
    };

    const successScore = metrics.successRate;
    const qualityScore = metrics.qualityScore;
    const latencyScore = Math.max(0, 1 - metrics.latency / 30000);
    const tokenScore = Math.max(0, 1 - metrics.tokenUsage / 10000);

    return (
      weights.success * successScore +
      weights.quality * qualityScore +
      weights.latency * latencyScore +
      weights.tokens * tokenScore
    );
  }

  private shouldEvolve(): boolean {
    const minEvaluations = this.candidates.reduce(
      (min, c) => Math.min(min, c.evaluationCount),
      Infinity
    );

    if (minEvaluations < 3) return false;

    const evaluationsSinceEvolution = this.history.filter(
      (h) => h.timestamp > this.getLastEvolutionTime()
    ).length;

    return evaluationsSinceEvolution >= 5;
  }

  private getLastEvolutionTime(): number {
    const latestGenCandidate = this.candidates.find(
      (c) => c.generation === this.currentGeneration && c.evaluationCount === 0
    );
    return latestGenCandidate ? Date.now() - 300000 : 0;
  }

  private getRelevantHistory(profile: TaskProfile): HistoricalRecord[] {
    return this.history
      .filter(
        (h) =>
          h.taskProfile.domain === profile.domain || h.taskProfile.complexity === profile.complexity
      )
      .slice(-10);
  }

  private mergeConfigs(
    base: ArchitectureConfig,
    overrides: Partial<ArchitectureConfig>
  ): ArchitectureConfig {
    return {
      ...base,
      ...Object.fromEntries(
        Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null)
      ),
    } as ArchitectureConfig;
  }

  private calculateMetrics(): EvolutionMetrics {
    const evaluatedCandidates = this.candidates.filter((c) => c.evaluationCount > 0);

    if (evaluatedCandidates.length === 0) {
      return {
        generation: this.currentGeneration,
        bestScore: 0,
        averageScore: 0,
        diversity: 1,
        convergenceRate: 0,
      };
    }

    const scores = evaluatedCandidates.map((c) => c.score);
    const bestScore = Math.max(...scores);
    const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const diversity = this.calculateDiversity();
    const convergenceRate = this.calculateConvergenceRate();

    return {
      generation: this.currentGeneration,
      bestScore,
      averageScore,
      diversity,
      convergenceRate,
    };
  }

  private calculateDiversity(): number {
    if (this.candidates.length < 2) return 1;

    let totalDiff = 0;
    let comparisons = 0;

    for (let i = 0; i < this.candidates.length; i++) {
      for (let j = i + 1; j < this.candidates.length; j++) {
        totalDiff += this.configDistance(this.candidates[i].config, this.candidates[j].config);
        comparisons++;
      }
    }

    return comparisons > 0 ? totalDiff / comparisons : 0;
  }

  private configDistance(a: Partial<ArchitectureConfig>, b: Partial<ArchitectureConfig>): number {
    let distance = 0;
    let fields = 0;

    if (a.temperature !== undefined && b.temperature !== undefined) {
      distance += Math.abs(a.temperature - b.temperature) / 2;
      fields++;
    }

    if (a.maxTokens !== undefined && b.maxTokens !== undefined) {
      distance += Math.abs(a.maxTokens - b.maxTokens) / 32000;
      fields++;
    }

    if (a.model !== b.model) {
      distance += 1;
      fields++;
    }

    return fields > 0 ? distance / fields : 0;
  }

  private calculateConvergenceRate(): number {
    if (this.history.length < 10) return 0;

    const recentScores = this.history.slice(-10).map((h) => h.score);
    const variance = this.calculateVariance(recentScores);

    return Math.max(0, 1 - variance * 4);
  }

  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  async analyzePerformance(): Promise<{
    recommendation: string;
    confidence: number;
    analysis: string;
  } | null> {
    if (this.candidates.length === 0 || this.history.length < 5) {
      return null;
    }

    const evaluatedCandidates = this.candidates.filter((c) => c.evaluationCount > 0);
    if (evaluatedCandidates.length === 0) return null;

    const results = evaluatedCandidates.map((c) => {
      const records = this.history.filter(
        (h) => JSON.stringify(h.config) === JSON.stringify(c.config)
      );
      const avgMetrics =
        records.length > 0
          ? {
              successRate: records.reduce((s, r) => s + r.metrics.successRate, 0) / records.length,
              avgLatency: records.reduce((s, r) => s + r.metrics.latency, 0) / records.length,
              avgTokens: records.reduce((s, r) => s + r.metrics.tokenUsage, 0) / records.length,
              qualityScore:
                records.reduce((s, r) => s + r.metrics.qualityScore, 0) / records.length,
            }
          : { successRate: 0, avgLatency: 0, avgTokens: 0, qualityScore: 0 };

      return { candidateId: c.id, metrics: avgMetrics };
    });

    const prompt = buildPerformanceAnalysisPrompt(evaluatedCandidates, results);

    try {
      const response = await this.callLLM(
        [
          { role: 'system', content: 'You are an AI performance analyst.' },
          { role: 'user', content: prompt },
        ],
        0.2
      );

      return parsePerformanceAnalysisResponse(response.content);
    } catch {
      return null;
    }
  }

  private async callLLM(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: number
  ) {
    if (this.llm.complete) {
      return this.llm.complete({ messages, temperature });
    }
    return this.llm.chat({ model: 'default', messages, temperature });
  }

  getCandidates(): EvolutionCandidate[] {
    return [...this.candidates];
  }

  getHistory(): HistoricalRecord[] {
    return [...this.history];
  }

  reset(): void {
    this.candidates = [];
    this.history = [];
    this.currentGeneration = 0;
    this.evolutionStrategy.reset();
  }
}
