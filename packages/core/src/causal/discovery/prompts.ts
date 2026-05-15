import type { CausalNode, CausalHypothesis, ExecutionTrace } from '@cogitator-ai/types';

export function buildCausalExtractionPrompt(
  source: string,
  existingNodes: CausalNode[],
  context?: { taskDescription?: string; recentActions?: string[] }
): string {
  const existingNodeList =
    existingNodes.length > 0
      ? `\nExisting variables in the causal graph:\n${existingNodes.map((n) => `- ${n.id}: ${n.name} (${n.variableType})`).join('\n')}`
      : '';

  const contextSection = context
    ? `\nContext:\n- Task: ${context.taskDescription || 'Not specified'}\n- Recent actions: ${context.recentActions?.join(', ') || 'None'}`
    : '';

  return `Analyze the following text and extract causal relationships.

For each causal relationship found, identify:
1. The cause variable (what produces the effect)
2. The effect variable (what is affected)
3. The relationship type: causes, enables, prevents, mediates, confounds, or moderates
4. Estimated strength (0.0 to 1.0)
5. Confidence in this relationship (0.0 to 1.0)
6. Brief mechanism description
${existingNodeList}
${contextSection}

Text to analyze:
"""
${source}
"""

Respond in JSON format:
{
  "relationships": [
    {
      "cause": { "id": "variable_id", "name": "Human readable name", "type": "observed|treatment|outcome|confounder|mediator|latent" },
      "effect": { "id": "variable_id", "name": "Human readable name", "type": "observed|treatment|outcome|confounder|mediator|latent" },
      "relationType": "causes|enables|prevents|mediates|confounds|moderates",
      "strength": 0.8,
      "confidence": 0.7,
      "mechanism": "Brief description of how cause affects effect"
    }
  ],
  "reasoning": "Brief explanation of the analysis"
}

Be conservative - only extract relationships that are clearly implied or stated. Prefer using existing variables when they match.`;
}

export function buildHypothesisGenerationPrompt(
  patterns: Array<{ trigger: string; effect: string; occurrences: number }>,
  traces: Array<{ id: string; summary: string; success: boolean }>,
  context: { agentId: string; goal?: string }
): string {
  const patternSection =
    patterns.length > 0
      ? `\nObserved patterns:\n${patterns.map((p) => `- "${p.trigger}" → "${p.effect}" (observed ${p.occurrences} times)`).join('\n')}`
      : '';

  const traceSection =
    traces.length > 0
      ? `\nRecent execution traces:\n${traces.map((t) => `- [${t.success ? 'SUCCESS' : 'FAILURE'}] ${t.summary}`).join('\n')}`
      : '';

  return `Generate causal hypotheses for agent ${context.agentId}.
${context.goal ? `Agent goal: ${context.goal}` : ''}
${patternSection}
${traceSection}

Generate hypotheses about causal relationships that could explain the observed patterns and outcomes.

Respond in JSON format:
{
  "hypotheses": [
    {
      "cause": "variable_id",
      "effect": "variable_id",
      "relationType": "causes|enables|prevents",
      "expectedStrength": 0.7,
      "rationale": "Why this relationship might exist",
      "testable": true,
      "testStrategy": "How to test this hypothesis"
    }
  ]
}

Focus on:
1. Relationships that explain failures
2. Patterns that predict success
3. Hidden confounders that might explain spurious correlations`;
}

export function buildCausalValidationPrompt(
  hypothesis: CausalHypothesis,
  originalTrace: { id: string; summary: string; outcome: string },
  forkTraces: Array<{ intervention: string; outcome: string; diffFromOriginal: string }>
): string {
  return `Validate the following causal hypothesis based on execution traces.

Hypothesis:
- Cause: ${hypothesis.cause}
- Effect: ${hypothesis.effect}
- Relationship: ${hypothesis.relationType}
- Expected strength: ${hypothesis.strength}

Original execution:
- Trace ID: ${originalTrace.id}
- Summary: ${originalTrace.summary}
- Outcome: ${originalTrace.outcome}

Forked executions (with interventions):
${forkTraces.map((f) => `- Intervention: ${f.intervention}\n  Outcome: ${f.outcome}\n  Difference: ${f.diffFromOriginal}`).join('\n\n')}

Analyze whether the evidence supports or refutes the hypothesis.

Respond in JSON format:
{
  "verdict": "validated|rejected|inconclusive",
  "confidence": 0.8,
  "evidence": [
    { "type": "supporting|refuting", "description": "..." }
  ],
  "adjustedStrength": 0.75,
  "reasoning": "Detailed analysis of the evidence"
}`;
}

export function buildErrorCausalAnalysisPrompt(
  error: { message: string; stack?: string },
  trace: ExecutionTrace,
  context: { recentActions: string[]; systemState: Record<string, unknown> }
): string {
  const steps = trace.steps.slice(-10).map((s) => ({
    action: s.toolCall ? `${s.toolCall.name}(${JSON.stringify(s.toolCall.arguments)})` : s.type,
    result: s.toolResult
      ? String(s.toolResult.result).substring(0, 200)
      : s.response?.substring(0, 200),
    success: !s.toolResult?.error,
  }));

  return `Analyze the causal chain that led to this error.

Error:
${error.message}
${error.stack ? `Stack: ${error.stack.substring(0, 500)}` : ''}

Recent execution steps:
${steps.map((s, i) => `${i + 1}. [${s.success ? 'OK' : 'FAIL'}] ${s.action}: ${s.result || 'no result'}`).join('\n')}

System context:
- Recent actions: ${context.recentActions.join(', ')}
- State: ${JSON.stringify(context.systemState, null, 2).substring(0, 500)}

Identify:
1. The root cause(s) of the error
2. Contributing factors
3. The causal chain from root cause to error
4. Preventive interventions

Respond in JSON format:
{
  "rootCauses": [
    {
      "variable": "cause_id",
      "description": "What went wrong",
      "contribution": 0.8,
      "actionable": true
    }
  ],
  "causalChain": [
    { "from": "cause1", "to": "cause2", "mechanism": "how it propagated" }
  ],
  "preventiveInterventions": [
    { "target": "variable", "action": "what to do", "expectedEffect": "outcome" }
  ],
  "reasoning": "Analysis explanation"
}`;
}

export interface ExtractedRelationship {
  cause: { id: string; name: string; type: string };
  effect: { id: string; name: string; type: string };
  relationType: string;
  strength: number;
  confidence: number;
  mechanism: string;
}

export interface CausalExtractionResult {
  relationships: ExtractedRelationship[];
  reasoning: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readUnitNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function parseExtractedVariable(value: unknown): { id: string; name: string; type: string } | null {
  if (!isRecord(value)) return null;

  const id = readNonEmptyString(value.id);
  if (!id) return null;

  return {
    id,
    name: readNonEmptyString(value.name) ?? id,
    type: readNonEmptyString(value.type) ?? 'observed',
  };
}

export function parseCausalExtractionResponse(response: string): CausalExtractionResult | null {
  try {
    const jsonMatch = /\{[\s\S]*\}/.exec(response);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as unknown;

    if (!isRecord(parsed) || !Array.isArray(parsed.relationships)) {
      return null;
    }

    const relationships: ExtractedRelationship[] = [];
    for (const item of parsed.relationships) {
      if (!isRecord(item)) continue;

      const cause = parseExtractedVariable(item.cause);
      const effect = parseExtractedVariable(item.effect);
      if (!cause || !effect) continue;

      relationships.push({
        cause,
        effect,
        relationType: readNonEmptyString(item.relationType) ?? 'causes',
        strength: readUnitNumber(item.strength, 0.5),
        confidence: readUnitNumber(item.confidence, 0.5),
        mechanism: readNonEmptyString(item.mechanism) ?? '',
      });
    }

    return {
      relationships,
      reasoning: readNonEmptyString(parsed.reasoning) ?? '',
    };
  } catch {
    return null;
  }
}

export interface GeneratedHypothesis {
  cause: string;
  effect: string;
  relationType: string;
  expectedStrength: number;
  rationale: string;
  testable: boolean;
  testStrategy: string;
}

export interface HypothesisGenerationResult {
  hypotheses: GeneratedHypothesis[];
}

export function parseHypothesisResponse(response: string): HypothesisGenerationResult | null {
  try {
    const jsonMatch = /\{[\s\S]*\}/.exec(response);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.hypotheses || !Array.isArray(parsed.hypotheses)) {
      return null;
    }

    return {
      hypotheses: parsed.hypotheses.map((h: Record<string, unknown>) => ({
        cause: h.cause as string,
        effect: h.effect as string,
        relationType: (h.relationType as string) || 'causes',
        expectedStrength: typeof h.expectedStrength === 'number' ? h.expectedStrength : 0.5,
        rationale: (h.rationale as string) || '',
        testable: h.testable !== false,
        testStrategy: (h.testStrategy as string) || '',
      })),
    };
  } catch {
    return null;
  }
}

export interface ValidationResult {
  verdict: 'validated' | 'rejected' | 'inconclusive';
  confidence: number;
  evidence: Array<{ type: 'supporting' | 'refuting'; description: string }>;
  adjustedStrength: number;
  reasoning: string;
}

export function parseValidationResponse(response: string): ValidationResult | null {
  try {
    const jsonMatch = /\{[\s\S]*\}/.exec(response);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    const verdict = parsed.verdict as string;
    if (!['validated', 'rejected', 'inconclusive'].includes(verdict)) {
      return null;
    }

    return {
      verdict: verdict as 'validated' | 'rejected' | 'inconclusive',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.map((e: Record<string, unknown>) => ({
            type: e.type as 'supporting' | 'refuting',
            description: e.description as string,
          }))
        : [],
      adjustedStrength: typeof parsed.adjustedStrength === 'number' ? parsed.adjustedStrength : 0.5,
      reasoning: (parsed.reasoning as string) || '',
    };
  } catch {
    return null;
  }
}

export interface RootCauseAnalysisResult {
  rootCauses: Array<{
    variable: string;
    description: string;
    contribution: number;
    actionable: boolean;
  }>;
  causalChain: Array<{
    from: string;
    to: string;
    mechanism: string;
  }>;
  preventiveInterventions: Array<{
    target: string;
    action: string;
    expectedEffect: string;
  }>;
  reasoning: string;
}

export function parseRootCauseResponse(response: string): RootCauseAnalysisResult | null {
  try {
    const jsonMatch = /\{[\s\S]*\}/.exec(response);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      rootCauses: Array.isArray(parsed.rootCauses)
        ? parsed.rootCauses.map((r: Record<string, unknown>) => ({
            variable: r.variable as string,
            description: r.description as string,
            contribution: typeof r.contribution === 'number' ? r.contribution : 0.5,
            actionable: r.actionable !== false,
          }))
        : [],
      causalChain: Array.isArray(parsed.causalChain)
        ? parsed.causalChain.map((c: Record<string, unknown>) => ({
            from: c.from as string,
            to: c.to as string,
            mechanism: c.mechanism as string,
          }))
        : [],
      preventiveInterventions: Array.isArray(parsed.preventiveInterventions)
        ? parsed.preventiveInterventions.map((p: Record<string, unknown>) => ({
            target: p.target as string,
            action: p.action as string,
            expectedEffect: p.expectedEffect as string,
          }))
        : [],
      reasoning: (parsed.reasoning as string) || '',
    };
  } catch {
    return null;
  }
}
