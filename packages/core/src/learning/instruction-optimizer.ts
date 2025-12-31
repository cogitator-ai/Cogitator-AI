import type {
  ExecutionTrace,
  TraceStore,
  InsightStore,
  Insight,
  InstructionGap,
  InstructionOptimizationResult,
  LLMBackend,
} from '@cogitator-ai/types';
import {
  buildFailureAnalysisPrompt,
  buildInstructionCandidatePrompt,
  buildInstructionEvaluationPrompt,
  buildInstructionRefinementPrompt,
  parseFailureAnalysisResponse,
  parseInstructionCandidatesResponse,
  parseInstructionEvaluationResponse,
  parseInstructionRefinementResponse,
} from './prompts';

export interface InstructionOptimizerOptions {
  llm: LLMBackend;
  model: string;
  traceStore: TraceStore;
  insightStore?: InsightStore;
  candidateCount?: number;
  refinementRounds?: number;
}

export class InstructionOptimizer {
  private llm: LLMBackend;
  private model: string;
  private traceStore: TraceStore;
  private insightStore?: InsightStore;
  private candidateCount: number;
  private refinementRounds: number;

  constructor(options: InstructionOptimizerOptions) {
    this.llm = options.llm;
    this.model = options.model;
    this.traceStore = options.traceStore;
    this.insightStore = options.insightStore;
    this.candidateCount = options.candidateCount ?? 3;
    this.refinementRounds = options.refinementRounds ?? 1;
  }

  async optimize(
    agentId: string,
    currentInstructions: string,
    options?: {
      traces?: ExecutionTrace[];
      maxTraces?: number;
      minScoreToConsider?: number;
    }
  ): Promise<InstructionOptimizationResult> {
    const traces = options?.traces ?? (await this.traceStore.getAll(agentId));
    const maxTraces = options?.maxTraces ?? 20;
    const relevantTraces = traces.slice(0, maxTraces);

    if (relevantTraces.length === 0) {
      return {
        originalInstructions: currentInstructions,
        optimizedInstructions: currentInstructions,
        improvement: 0,
        gapsAddressed: [],
        candidatesEvaluated: 0,
        reasoning: 'No traces available for optimization',
      };
    }

    const gaps = await this.analyzeFailures(relevantTraces, currentInstructions);

    if (gaps.length === 0) {
      return {
        originalInstructions: currentInstructions,
        optimizedInstructions: currentInstructions,
        improvement: 0,
        gapsAddressed: [],
        candidatesEvaluated: 0,
        reasoning: 'No instruction gaps identified',
      };
    }

    const insights = this.insightStore
      ? await this.insightStore.findRelevant(agentId, currentInstructions, 10)
      : [];

    const candidates = await this.generateCandidates(currentInstructions, gaps, insights);

    if (candidates.length === 0) {
      return {
        originalInstructions: currentInstructions,
        optimizedInstructions: currentInstructions,
        improvement: 0,
        gapsAddressed: gaps,
        candidatesEvaluated: 0,
        reasoning: 'Failed to generate instruction candidates',
      };
    }

    const evaluations = await this.evaluateCandidates(candidates, relevantTraces);

    let bestCandidate = candidates[0];
    let bestScore = 0;
    let bestEvaluation = evaluations.get(candidates[0]) ?? { score: 0, weaknesses: [] };

    for (const [candidate, evaluation] of evaluations) {
      if (evaluation.score > bestScore) {
        bestScore = evaluation.score;
        bestCandidate = candidate;
        bestEvaluation = evaluation;
      }
    }

    let finalInstructions = bestCandidate;
    for (let round = 0; round < this.refinementRounds; round++) {
      if (bestEvaluation.weaknesses.length === 0) break;

      const refined = await this.refineInstructions(finalInstructions, bestEvaluation.weaknesses);

      if (refined) {
        finalInstructions = refined;
      }
    }

    const originalScore = await this.estimateInstructionScore(currentInstructions, relevantTraces);
    const newScore = await this.estimateInstructionScore(finalInstructions, relevantTraces);

    return {
      originalInstructions: currentInstructions,
      optimizedInstructions: finalInstructions,
      improvement: newScore - originalScore,
      gapsAddressed: gaps,
      candidatesEvaluated: candidates.length,
      reasoning: `Identified ${gaps.length} gaps, evaluated ${candidates.length} candidates, best score: ${bestScore.toFixed(2)}`,
    };
  }

  private async analyzeFailures(
    traces: ExecutionTrace[],
    currentInstructions: string
  ): Promise<InstructionGap[]> {
    const prompt = buildFailureAnalysisPrompt(traces, currentInstructions);

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        maxTokens: 1000,
      });

      const parsed = parseFailureAnalysisResponse(response.content);
      return parsed?.gaps ?? [];
    } catch {
      return [];
    }
  }

  private async generateCandidates(
    currentInstructions: string,
    gaps: InstructionGap[],
    insights: Insight[]
  ): Promise<string[]> {
    const prompt = buildInstructionCandidatePrompt(currentInstructions, gaps, insights);

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        maxTokens: 2000,
      });

      const parsed = parseInstructionCandidatesResponse(response.content);
      return parsed
        .map((c) => c.instructions)
        .filter((i) => i.length > 0)
        .slice(0, this.candidateCount);
    } catch {
      return [];
    }
  }

  private async evaluateCandidates(
    candidates: string[],
    traces: ExecutionTrace[]
  ): Promise<Map<string, { score: number; weaknesses: string[] }>> {
    const evaluations = new Map<string, { score: number; weaknesses: string[] }>();

    for (const candidate of candidates) {
      const prompt = buildInstructionEvaluationPrompt(candidate, traces);

      try {
        const response = await this.llm.chat({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          maxTokens: 500,
        });

        const parsed = parseInstructionEvaluationResponse(response.content);
        if (parsed) {
          evaluations.set(candidate, {
            score: parsed.score,
            weaknesses: parsed.weaknesses,
          });
        } else {
          evaluations.set(candidate, { score: 0.5, weaknesses: [] });
        }
      } catch {
        evaluations.set(candidate, { score: 0.5, weaknesses: [] });
      }
    }

    return evaluations;
  }

  private async refineInstructions(
    candidate: string,
    weaknesses: string[]
  ): Promise<string | null> {
    const prompt = buildInstructionRefinementPrompt(candidate, weaknesses);

    try {
      const response = await this.llm.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        maxTokens: 1500,
      });

      const parsed = parseInstructionRefinementResponse(response.content);
      return parsed?.instructions ?? null;
    } catch {
      return null;
    }
  }

  private async estimateInstructionScore(
    instructions: string,
    traces: ExecutionTrace[]
  ): Promise<number> {
    const successfulTraces = traces.filter((t) => t.metrics.success);

    const baseScore = traces.length > 0 ? successfulTraces.length / traces.length : 0.5;

    const avgTraceScore =
      traces.length > 0 ? traces.reduce((sum, t) => sum + t.score, 0) / traces.length : 0.5;

    const instructionLength = instructions.length;
    const conciseBonus = instructionLength < 500 ? 0.1 : instructionLength > 1500 ? -0.1 : 0;

    return Math.max(0, Math.min(1, baseScore * 0.4 + avgTraceScore * 0.5 + 0.5 + conciseBonus));
  }
}
