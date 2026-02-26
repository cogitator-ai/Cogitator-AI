import type {
  CausalHypothesis,
  CausalPattern,
  CausalRelationType,
  ExecutionTrace,
  LLMBackend,
} from '@cogitator-ai/types';
import {
  buildHypothesisGenerationPrompt,
  parseHypothesisResponse,
  GeneratedHypothesis,
} from './prompts';
import { nanoid } from 'nanoid';

export interface HypothesisGeneratorOptions {
  llmBackend: LLMBackend;
  model?: string;
  maxHypothesesPerBatch?: number;
  minExpectedStrength?: number;
}

export class CausalHypothesisGenerator {
  private llm: LLMBackend;
  private model: string;
  private maxHypothesesPerBatch: number;
  private minExpectedStrength: number;
  private pendingHypotheses = new Map<string, CausalHypothesis[]>();

  constructor(options: HypothesisGeneratorOptions) {
    this.llm = options.llmBackend;
    this.model = options.model ?? 'gpt-4';
    this.maxHypothesesPerBatch = options.maxHypothesesPerBatch ?? 5;
    this.minExpectedStrength = options.minExpectedStrength ?? 0.3;
  }

  async generateHypotheses(
    patterns: CausalPattern[],
    traces: ExecutionTrace[],
    context: { agentId: string; goal?: string }
  ): Promise<CausalHypothesis[]> {
    const patternSummaries = patterns.map((p) => ({
      trigger: p.pattern.trigger,
      effect: p.pattern.effect,
      occurrences: p.occurrences,
    }));

    const traceSummaries = traces.slice(-10).map((t) => ({
      id: t.id,
      summary: this.summarizeTrace(t),
      success: t.metrics?.success ?? true,
    }));

    const prompt = buildHypothesisGenerationPrompt(patternSummaries, traceSummaries, context);

    const response = await this.llm.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
    });

    const parsed = parseHypothesisResponse(response.content);

    if (!parsed) {
      return [];
    }

    const hypotheses = parsed.hypotheses
      .filter((h) => h.expectedStrength >= this.minExpectedStrength)
      .slice(0, this.maxHypothesesPerBatch)
      .map((h) => this.createHypothesis(h, context.agentId));

    const existing = this.pendingHypotheses.get(context.agentId) || [];
    this.pendingHypotheses.set(context.agentId, [...existing, ...hypotheses]);

    return hypotheses;
  }

  async generateFromFailure(
    trace: ExecutionTrace,
    context: { agentId: string; errorMessage?: string }
  ): Promise<CausalHypothesis[]> {
    const failedSteps = trace.steps.filter((s) => s.toolResult?.error);

    if (failedSteps.length === 0) {
      return [];
    }

    const describeStep = (s: ExecutionTrace['steps'][0]) =>
      s.toolCall ? `${s.toolCall.name}(${JSON.stringify(s.toolCall.arguments)})` : s.type;

    const prompt = `Analyze this failed execution and generate causal hypotheses about what caused the failure.

Failed steps:
${failedSteps.map((s) => `- ${describeStep(s)}: ${s.toolResult?.error || 'Unknown error'}`).join('\n')}

Error: ${context.errorMessage || 'Unknown'}

Recent successful steps before failure:
${trace.steps
  .filter((s) => !s.toolResult?.error)
  .slice(-5)
  .map((s) => `- ${describeStep(s)}`)
  .join('\n')}

Generate hypotheses about:
1. What actions or conditions caused the failure
2. What confounders might have influenced the outcome
3. What preventive measures could avoid this failure

Respond in JSON format:
{
  "hypotheses": [
    {
      "cause": "cause_variable",
      "effect": "failure_effect",
      "relationType": "causes|enables|prevents",
      "expectedStrength": 0.8,
      "rationale": "Why this caused the failure",
      "testable": true,
      "testStrategy": "How to test this hypothesis"
    }
  ]
}`;

    const response = await this.llm.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    });

    const parsed = parseHypothesisResponse(response.content);

    if (!parsed) {
      return [];
    }

    return parsed.hypotheses.map((h) => this.createHypothesis(h, context.agentId));
  }

  async generateFromSuccess(
    trace: ExecutionTrace,
    context: { agentId: string; outcome: string }
  ): Promise<CausalHypothesis[]> {
    const describeStep = (s: ExecutionTrace['steps'][0]) =>
      s.toolCall ? `${s.toolCall.name}(${JSON.stringify(s.toolCall.arguments)})` : s.type;

    const prompt = `Analyze this successful execution and generate causal hypotheses about what led to success.

Outcome: ${context.outcome}

Key steps:
${trace.steps
  .slice(-10)
  .map((s) => `- [${!s.toolResult?.error ? 'OK' : 'FAIL'}] ${describeStep(s)}`)
  .join('\n')}

Generate hypotheses about:
1. What actions were critical for success
2. What enabling conditions made success possible
3. What patterns could be reused in future tasks

Respond in JSON format:
{
  "hypotheses": [
    {
      "cause": "successful_action",
      "effect": "positive_outcome",
      "relationType": "causes|enables",
      "expectedStrength": 0.7,
      "rationale": "Why this contributed to success",
      "testable": true,
      "testStrategy": "How to verify this pattern"
    }
  ]
}`;

    const response = await this.llm.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    });

    const parsed = parseHypothesisResponse(response.content);

    if (!parsed) {
      return [];
    }

    return parsed.hypotheses.map((h) => this.createHypothesis(h, context.agentId));
  }

  getNextHypothesisToTest(agentId: string): CausalHypothesis | null {
    const hypotheses = this.pendingHypotheses.get(agentId) || [];
    const pending = hypotheses.filter((h) => h.status === 'pending');

    if (pending.length === 0) {
      return null;
    }

    pending.sort((a, b) => {
      const scoreA = a.strength * a.confidence;
      const scoreB = b.strength * b.confidence;
      return scoreB - scoreA;
    });

    const selected = pending[0];
    selected.status = 'testing';

    return selected;
  }

  markHypothesisValidated(
    hypothesisId: string,
    adjustedStrength: number,
    adjustedConfidence: number
  ): void {
    for (const [, hypotheses] of this.pendingHypotheses) {
      const hypothesis = hypotheses.find((h) => h.id === hypothesisId);
      if (hypothesis) {
        hypothesis.status = 'validated';
        hypothesis.strength = adjustedStrength;
        hypothesis.confidence = adjustedConfidence;
        hypothesis.testedAt = Date.now();
        break;
      }
    }
  }

  markHypothesisRejected(hypothesisId: string, reason: string): void {
    for (const [, hypotheses] of this.pendingHypotheses) {
      const hypothesis = hypotheses.find((h) => h.id === hypothesisId);
      if (hypothesis) {
        hypothesis.status = 'rejected';
        hypothesis.testedAt = Date.now();
        hypothesis.evidence.push({
          type: 'counterfactual',
          description: `Rejected: ${reason}`,
          strength: 0,
          timestamp: Date.now(),
        });
        break;
      }
    }
  }

  getPendingHypotheses(agentId: string): CausalHypothesis[] {
    return (this.pendingHypotheses.get(agentId) || []).filter((h) => h.status === 'pending');
  }

  getValidatedHypotheses(agentId: string): CausalHypothesis[] {
    return (this.pendingHypotheses.get(agentId) || []).filter((h) => h.status === 'validated');
  }

  clearHypotheses(agentId: string): void {
    this.pendingHypotheses.delete(agentId);
  }

  private createHypothesis(generated: GeneratedHypothesis, _agentId: string): CausalHypothesis {
    return {
      id: `hypothesis-${nanoid(8)}`,
      cause: generated.cause,
      effect: generated.effect,
      relationType: this.mapRelationType(generated.relationType),
      strength: generated.expectedStrength,
      confidence: 0.5,
      source: 'extraction',
      evidence: [
        {
          type: 'observational',
          description: generated.rationale,
          strength: generated.expectedStrength,
          timestamp: Date.now(),
        },
      ],
      status: 'pending',
      createdAt: Date.now(),
    };
  }

  private mapRelationType(type: string): CausalRelationType {
    const mapping: Record<string, CausalRelationType> = {
      causes: 'causes',
      enables: 'enables',
      prevents: 'prevents',
      mediates: 'mediates',
      confounds: 'confounds',
      moderates: 'moderates',
    };
    return mapping[type.toLowerCase()] ?? 'causes';
  }

  private summarizeTrace(trace: ExecutionTrace): string {
    const stepCount = trace.steps.length;
    const successCount = trace.steps.filter((s) => !s.toolResult?.error).length;
    const lastStep = trace.steps[trace.steps.length - 1];
    const lastAction = lastStep?.toolCall?.name || lastStep?.type || 'Unknown';

    return `${stepCount} steps (${successCount} successful), last: ${lastAction}`;
  }
}
