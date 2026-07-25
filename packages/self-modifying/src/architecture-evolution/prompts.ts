import type { TaskProfile, ArchitectureConfig, EvolutionCandidate } from '@cogitator-ai/types';
import { extractJson } from '../utils';

export const ARCHITECTURE_ANALYSIS_SYSTEM_PROMPT = `You are an expert in AI agent architecture optimization.
Your task is to analyze tasks and recommend optimal configurations.

Consider these factors:
1. Task complexity - simple tasks need lighter models, complex need stronger
2. Domain requirements - some domains need specific capabilities
3. Resource constraints - balance performance vs cost
4. Historical performance - learn from past executions

Always provide structured JSON responses.`;

export function buildTaskProfilePrompt(
  taskDescription: string,
  context?: {
    previousTasks?: string[];
    availableModels?: string[];
    constraints?: { maxCost?: number; maxLatency?: number };
  }
): string {
  const contextSection = context
    ? `
CONTEXT:
${context.previousTasks?.length ? `Previous tasks: ${context.previousTasks.slice(-3).join(', ')}` : ''}
${context.availableModels?.length ? `Available models: ${context.availableModels.join(', ')}` : ''}
${context.constraints?.maxCost ? `Max cost: $${context.constraints.maxCost}` : ''}
${context.constraints?.maxLatency ? `Max latency: ${context.constraints.maxLatency}ms` : ''}`
    : '';

  return `Analyze the following task and create a profile for architecture optimization.

TASK:
${taskDescription}
${contextSection}

Respond with a JSON object:
{
  "complexity": "trivial" | "simple" | "moderate" | "complex" | "expert" | "extreme",
  "domain": "general" | "coding" | "reasoning" | "creative" | "factual" | "conversational",
  "estimatedTokens": number,
  "requiresTools": boolean,
  "requiresReasoning": boolean,
  "requiresCreativity": boolean,
  "toolIntensity": "none" | "light" | "moderate" | "heavy",
  "reasoningDepth": "shallow" | "moderate" | "deep" | "exhaustive",
  "creativityLevel": "low" | "moderate" | "high",
  "accuracyRequirement": "approximate" | "moderate" | "high" | "critical",
  "timeConstraint": "none" | "relaxed" | "moderate" | "strict",
  "suggestedApproach": "Brief description of recommended approach",
  "riskFactors": ["List of potential challenges"]
}`;
}

export function buildCandidateGenerationPrompt(
  profile: TaskProfile,
  currentConfig: ArchitectureConfig,
  historicalPerformance?: Array<{
    config: Partial<ArchitectureConfig>;
    score: number;
    metrics: Record<string, number>;
  }>
): string {
  const historySection = historicalPerformance?.length
    ? `
HISTORICAL PERFORMANCE:
${historicalPerformance
  .slice(-5)
  .map(
    (h, i) =>
      `${i + 1}. Config: ${JSON.stringify(h.config)} → Score: ${h.score.toFixed(2)}, Metrics: ${JSON.stringify(h.metrics)}`
  )
  .join('\n')}`
    : '';

  return `Generate candidate configurations for architecture evolution.

TASK PROFILE:
${JSON.stringify(profile, null, 2)}

CURRENT CONFIG:
${JSON.stringify(currentConfig, null, 2)}
${historySection}

Generate 3-5 candidate configurations that might improve performance.
Each candidate should modify 1-3 parameters from current config.

Respond with a JSON array:
[
  {
    "id": "candidate_1",
    "config": {
      "model": "model name or null to keep current",
      "temperature": number or null,
      "maxTokens": number or null,
      "systemPromptAdditions": "additional instructions or null",
      "toolStrategy": "sequential" | "parallel" | "adaptive" | null,
      "reflectionDepth": number or null
    },
    "reasoning": "Why this configuration might help",
    "expectedImprovement": 0.0-1.0,
    "risk": "low" | "medium" | "high"
  }
]`;
}

export function buildPerformanceAnalysisPrompt(
  candidates: EvolutionCandidate[],
  results: Array<{
    candidateId: string;
    metrics: {
      successRate: number;
      avgLatency: number;
      avgTokens: number;
      qualityScore: number;
    };
  }>
): string {
  return `Analyze the performance of architecture candidates and recommend the best configuration.

CANDIDATES AND RESULTS:
${candidates
  .map((c) => {
    const result = results.find((r) => r.candidateId === c.id);
    return `
${c.id}:
  Config: ${JSON.stringify(c.config)}
  Reasoning: ${c.reasoning}
  ${result ? `Results: ${JSON.stringify(result.metrics)}` : 'Not yet tested'}`;
  })
  .join('\n')}

Respond with:
{
  "recommendation": "candidate_id of best candidate",
  "confidence": 0.0-1.0,
  "analysis": "Detailed analysis of results",
  "suggestedNextExperiments": ["List of additional experiments to try"],
  "shouldAdopt": boolean,
  "adoptionReason": "Why to adopt or not adopt the recommendation"
}`;
}

export function parseTaskProfileResponse(response: string): TaskProfile | null {
  const json = extractJson(response);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);

    return {
      complexity: parsed.complexity || 'moderate',
      domain: parsed.domain || 'general',
      estimatedTokens: parsed.estimatedTokens || 1000,
      requiresTools: Boolean(parsed.requiresTools),
      requiresReasoning: Boolean(parsed.requiresReasoning),
      requiresCreativity: Boolean(parsed.requiresCreativity),
      toolIntensity: parsed.toolIntensity || 'none',
      reasoningDepth: parsed.reasoningDepth || 'moderate',
      creativityLevel: parsed.creativityLevel || 'moderate',
      accuracyRequirement: parsed.accuracyRequirement || 'moderate',
      timeConstraint: parsed.timeConstraint || 'none',
    };
  } catch {
    return null;
  }
}

export function parseCandidateGenerationResponse(response: string): EvolutionCandidate[] {
  const json = extractJsonArray(response);
  if (!json) return [];

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((c: Record<string, unknown>) => c && typeof c === 'object' && c.config)
      .map((c: Record<string, unknown>, idx: number) => ({
        id: String(c.id || `candidate_${idx}`),
        config: c.config as Partial<ArchitectureConfig>,
        reasoning: String(c.reasoning || ''),
        expectedImprovement:
          typeof c.expectedImprovement === 'number' ? c.expectedImprovement : 0.5,
        risk: (['low', 'medium', 'high'].includes(String(c.risk)) ? c.risk : 'medium') as
          | 'low'
          | 'medium'
          | 'high',
        generation: 0,
        score: 0,
        evaluationCount: 0,
      }));
  } catch {
    return [];
  }
}

export function parsePerformanceAnalysisResponse(response: string): {
  recommendation: string;
  confidence: number;
  shouldAdopt: boolean;
  analysis: string;
} | null {
  const json = extractJson(response);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);

    return {
      recommendation: String(parsed.recommendation || ''),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      shouldAdopt: Boolean(parsed.shouldAdopt),
      analysis: String(parsed.analysis || ''),
    };
  } catch {
    return null;
  }
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
