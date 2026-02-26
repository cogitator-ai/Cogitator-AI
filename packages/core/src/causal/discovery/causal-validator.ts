import type {
  CausalHypothesis,
  CausalEvidence,
  ExecutionTrace,
  ExecutionStep,
  LLMBackend,
} from '@cogitator-ai/types';
import { buildCausalValidationPrompt, parseValidationResponse } from './prompts';

export interface CausalValidatorOptions {
  llmBackend: LLMBackend;
  model?: string;
  validationThreshold?: number;
  maxForksPerHypothesis?: number;
}

export interface ValidationContext {
  originalTrace: ExecutionTrace;
  forkResults: Array<{
    intervention: Record<string, unknown>;
    trace: ExecutionTrace;
  }>;
}

export interface ForkRequest {
  hypothesisId: string;
  checkpointId: string;
  intervention: Record<string, unknown>;
  description: string;
}

export class CausalValidator {
  private llm: LLMBackend;
  private model: string;
  private validationThreshold: number;
  private maxForksPerHypothesis: number;

  constructor(options: CausalValidatorOptions) {
    this.llm = options.llmBackend;
    this.model = options.model ?? 'gpt-4';
    this.validationThreshold = options.validationThreshold ?? 0.7;
    this.maxForksPerHypothesis = options.maxForksPerHypothesis ?? 3;
  }

  async validateHypothesis(
    hypothesis: CausalHypothesis,
    context: ValidationContext
  ): Promise<{
    validated: boolean;
    adjustedStrength: number;
    adjustedConfidence: number;
    evidence: CausalEvidence[];
    reasoning: string;
  }> {
    const originalSummary = this.summarizeTrace(context.originalTrace);

    const forkSummaries = context.forkResults.map((fork) => ({
      intervention: JSON.stringify(fork.intervention),
      outcome: this.summarizeOutcome(fork.trace),
      diffFromOriginal: this.compareTraces(context.originalTrace, fork.trace),
    }));

    const prompt = buildCausalValidationPrompt(
      hypothesis,
      {
        id: context.originalTrace.id,
        summary: originalSummary,
        outcome: this.summarizeOutcome(context.originalTrace),
      },
      forkSummaries
    );

    const response = await this.llm.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    const parsed = parseValidationResponse(response.content);

    if (!parsed) {
      return {
        validated: false,
        adjustedStrength: hypothesis.strength,
        adjustedConfidence: hypothesis.confidence * 0.5,
        evidence: [],
        reasoning: 'Failed to parse validation response',
      };
    }

    const validated =
      parsed.verdict === 'validated' && parsed.confidence >= this.validationThreshold;

    const newEvidence: CausalEvidence[] = parsed.evidence.map((e) => ({
      type: 'counterfactual' as const,
      description: e.description,
      strength: e.type === 'supporting' ? parsed.adjustedStrength : 0,
      timestamp: Date.now(),
    }));

    return {
      validated,
      adjustedStrength: parsed.adjustedStrength,
      adjustedConfidence: parsed.confidence,
      evidence: newEvidence,
      reasoning: parsed.reasoning,
    };
  }

  async validateFromObservations(
    hypothesis: CausalHypothesis,
    traces: ExecutionTrace[]
  ): Promise<{
    validated: boolean;
    adjustedStrength: number;
    adjustedConfidence: number;
    evidence: CausalEvidence[];
  }> {
    let supportingCount = 0;
    let refutingCount = 0;
    const evidence: CausalEvidence[] = [];

    for (const trace of traces) {
      const analysis = this.analyzeTraceForHypothesis(hypothesis, trace);

      if (analysis.supports) {
        supportingCount++;
        evidence.push({
          type: 'observational',
          description: analysis.reasoning,
          strength: analysis.strength,
          traceId: trace.id,
          timestamp: Date.now(),
        });
      } else if (analysis.refutes) {
        refutingCount++;
        evidence.push({
          type: 'observational',
          description: analysis.reasoning,
          strength: -analysis.strength,
          traceId: trace.id,
          timestamp: Date.now(),
        });
      }
    }

    const total = supportingCount + refutingCount;
    if (total === 0) {
      return {
        validated: false,
        adjustedStrength: hypothesis.strength,
        adjustedConfidence: hypothesis.confidence,
        evidence: [],
      };
    }

    const supportRatio = supportingCount / total;
    const adjustedStrength = hypothesis.strength * supportRatio;
    const adjustedConfidence = Math.min(0.95, hypothesis.confidence + (supportRatio - 0.5) * 0.3);

    return {
      validated: supportRatio >= 0.7 && adjustedConfidence >= this.validationThreshold,
      adjustedStrength,
      adjustedConfidence,
      evidence,
    };
  }

  generateForkRequests(hypothesis: CausalHypothesis, checkpointId: string): ForkRequest[] {
    const requests: ForkRequest[] = [];

    requests.push({
      hypothesisId: hypothesis.id,
      checkpointId,
      intervention: { [hypothesis.cause]: null },
      description: `Remove ${hypothesis.cause} to test if ${hypothesis.effect} still occurs`,
    });

    if (hypothesis.relationType === 'causes' || hypothesis.relationType === 'enables') {
      requests.push({
        hypothesisId: hypothesis.id,
        checkpointId,
        intervention: { [hypothesis.cause]: 'amplified' },
        description: `Amplify ${hypothesis.cause} to test if ${hypothesis.effect} increases`,
      });
    }

    if (hypothesis.relationType === 'prevents') {
      requests.push({
        hypothesisId: hypothesis.id,
        checkpointId,
        intervention: { [hypothesis.cause]: 'removed' },
        description: `Remove prevention to test if ${hypothesis.effect} occurs`,
      });
    }

    return requests.slice(0, this.maxForksPerHypothesis);
  }

  private analyzeTraceForHypothesis(
    hypothesis: CausalHypothesis,
    trace: ExecutionTrace
  ): { supports: boolean; refutes: boolean; strength: number; reasoning: string } {
    const causePresent = this.variablePresentInTrace(hypothesis.cause, trace);
    const effectPresent = this.variablePresentInTrace(hypothesis.effect, trace);

    if (hypothesis.relationType === 'causes' || hypothesis.relationType === 'enables') {
      if (causePresent && effectPresent) {
        return {
          supports: true,
          refutes: false,
          strength: 0.6,
          reasoning: `Both ${hypothesis.cause} and ${hypothesis.effect} present`,
        };
      }
      if (causePresent && !effectPresent) {
        return {
          supports: false,
          refutes: true,
          strength: 0.4,
          reasoning: `${hypothesis.cause} present but ${hypothesis.effect} absent`,
        };
      }
    }

    if (hypothesis.relationType === 'prevents') {
      if (causePresent && !effectPresent) {
        return {
          supports: true,
          refutes: false,
          strength: 0.6,
          reasoning: `${hypothesis.cause} present and ${hypothesis.effect} prevented`,
        };
      }
      if (causePresent && effectPresent) {
        return {
          supports: false,
          refutes: true,
          strength: 0.5,
          reasoning: `${hypothesis.cause} present but ${hypothesis.effect} still occurred`,
        };
      }
    }

    return {
      supports: false,
      refutes: false,
      strength: 0,
      reasoning: 'Insufficient evidence in trace',
    };
  }

  private variablePresentInTrace(variable: string, trace: ExecutionTrace): boolean {
    const searchTerm = variable.toLowerCase();

    for (const step of trace.steps) {
      const action = this.describeStep(step).toLowerCase();
      if (action.includes(searchTerm)) {
        return true;
      }
      const result = this.getStepResult(step)?.toLowerCase();
      if (result?.includes(searchTerm)) {
        return true;
      }
    }

    return false;
  }

  private summarizeTrace(trace: ExecutionTrace): string {
    const steps = trace.steps.slice(-5);
    return steps
      .map((s) => `${this.describeStep(s)} → ${this.isStepSuccessful(s) ? 'OK' : 'FAIL'}`)
      .join('; ');
  }

  private summarizeOutcome(trace: ExecutionTrace): string {
    const lastStep = trace.steps[trace.steps.length - 1];
    const success = trace.metrics?.success ?? (lastStep ? this.isStepSuccessful(lastStep) : false);
    const result = lastStep ? this.getStepResult(lastStep) : null;
    return `${success ? 'Success' : 'Failure'}: ${result?.substring(0, 100) || 'No result'}`;
  }

  private compareTraces(original: ExecutionTrace, fork: ExecutionTrace): string {
    const originalSuccess = original.metrics?.success ?? true;
    const forkSuccess = fork.metrics?.success ?? true;

    if (originalSuccess !== forkSuccess) {
      return `Outcome changed from ${originalSuccess ? 'success' : 'failure'} to ${forkSuccess ? 'success' : 'failure'}`;
    }

    const originalSteps = original.steps.length;
    const forkSteps = fork.steps.length;

    if (originalSteps !== forkSteps) {
      return `Step count changed from ${originalSteps} to ${forkSteps}`;
    }

    let differences = 0;
    for (let i = 0; i < Math.min(originalSteps, forkSteps); i++) {
      if (this.describeStep(original.steps[i]) !== this.describeStep(fork.steps[i])) {
        differences++;
      }
    }

    if (differences > 0) {
      return `${differences} steps differed in actions`;
    }

    return 'No significant differences observed';
  }

  private describeStep(step: ExecutionStep): string {
    if (step.toolCall) {
      return `${step.toolCall.name}(${JSON.stringify(step.toolCall.arguments)})`;
    }
    return step.type;
  }

  private getStepResult(step: ExecutionStep): string | null {
    if (step.toolResult) {
      return String(step.toolResult.result);
    }
    return step.response || null;
  }

  private isStepSuccessful(step: ExecutionStep): boolean {
    return !step.toolResult?.error;
  }
}
