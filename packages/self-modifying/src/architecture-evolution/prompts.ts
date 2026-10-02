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
  }>,
  options: { availableModels?: string[] } = {}
): string {
  const availableModels = options.availableModels ?? [];
  const modelLine =
    availableModels.length > 0
      ? `\n      "model": ${availableModels.map((m) => JSON.stringify(m)).join(' | ')} | null,`
      : '';
  const modelRule =
    availableModels.length > 0
      ? `Only use models from this list: ${availableModels.join(', ')}.`
      : 'Do not change the model.';
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
${modelRule}

Respond with a JSON array:
[
  {
    "id": "candidate_1",
    "config": {${modelLine}
      "temperature": number between 0 and 2 or null,
      "maxTokens": number or null,
      "toolStrategy": "sequential" | "parallel" | "adaptive" | null,
      "reflectionDepth": integer between 0 and 5 or null
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

const COMPLEXITIES: readonly TaskProfile['complexity'][] = [
  'trivial',
  'simple',
  'moderate',
  'complex',
  'expert',
  'extreme',
];
const DOMAINS: readonly TaskProfile['domain'][] = [
  'general',
  'coding',
  'reasoning',
  'creative',
  'factual',
  'conversational',
];
const TOOL_INTENSITIES: readonly TaskProfile['toolIntensity'][] = [
  'none',
  'light',
  'moderate',
  'heavy',
];
const REASONING_DEPTHS: readonly TaskProfile['reasoningDepth'][] = [
  'shallow',
  'moderate',
  'deep',
  'exhaustive',
];
const CREATIVITY_LEVELS: readonly TaskProfile['creativityLevel'][] = ['low', 'moderate', 'high'];
const ACCURACY_LEVELS: readonly TaskProfile['accuracyRequirement'][] = [
  'approximate',
  'moderate',
  'high',
  'critical',
];
const TIME_CONSTRAINTS: readonly TaskProfile['timeConstraint'][] = [
  'none',
  'relaxed',
  'moderate',
  'strict',
];
const TOOL_STRATEGIES: readonly ArchitectureConfig['toolStrategy'][] = [
  'sequential',
  'parallel',
  'adaptive',
];
const RISKS: readonly EvolutionCandidate['risk'][] = ['low', 'medium', 'high'];

export const MAX_TOKENS_RANGE = { min: 100, max: 32000 } as const;
export const REFLECTION_DEPTH_RANGE = { min: 0, max: 5 } as const;
export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTaskProfileResponse(response: string): TaskProfile | null {
  const json = extractJson(response);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const estimatedTokens = finiteNumber(parsed.estimatedTokens);

  return {
    complexity: pickEnum(parsed.complexity, COMPLEXITIES, 'moderate'),
    domain: pickEnum(parsed.domain, DOMAINS, 'general'),
    estimatedTokens:
      estimatedTokens !== undefined && estimatedTokens > 0 ? Math.round(estimatedTokens) : 1000,
    requiresTools: Boolean(parsed.requiresTools),
    requiresReasoning: Boolean(parsed.requiresReasoning),
    requiresCreativity: Boolean(parsed.requiresCreativity),
    toolIntensity: pickEnum(parsed.toolIntensity, TOOL_INTENSITIES, 'none'),
    reasoningDepth: pickEnum(parsed.reasoningDepth, REASONING_DEPTHS, 'moderate'),
    creativityLevel: pickEnum(parsed.creativityLevel, CREATIVITY_LEVELS, 'moderate'),
    accuracyRequirement: pickEnum(parsed.accuracyRequirement, ACCURACY_LEVELS, 'moderate'),
    timeConstraint: pickEnum(parsed.timeConstraint, TIME_CONSTRAINTS, 'none'),
  };
}

export function sanitizeCandidateConfig(
  raw: unknown,
  options: { availableModels?: string[] } = {}
): Partial<ArchitectureConfig> {
  if (!isRecord(raw)) return {};
  const config: Partial<ArchitectureConfig> = {};

  if (typeof raw.model === 'string' && options.availableModels?.includes(raw.model)) {
    config.model = raw.model;
  }

  const temperature = finiteNumber(raw.temperature);
  if (temperature !== undefined) {
    config.temperature = clamp(temperature, TEMPERATURE_RANGE);
  }

  const maxTokens = finiteNumber(raw.maxTokens);
  if (maxTokens !== undefined) {
    config.maxTokens = clamp(Math.round(maxTokens), MAX_TOKENS_RANGE);
  }

  if (
    typeof raw.toolStrategy === 'string' &&
    (TOOL_STRATEGIES as readonly string[]).includes(raw.toolStrategy)
  ) {
    config.toolStrategy = raw.toolStrategy as ArchitectureConfig['toolStrategy'];
  }

  const reflectionDepth = finiteNumber(raw.reflectionDepth);
  if (reflectionDepth !== undefined) {
    config.reflectionDepth = clamp(Math.round(reflectionDepth), REFLECTION_DEPTH_RANGE);
  }

  return config;
}

export function parseCandidateGenerationResponse(
  response: string,
  options: { availableModels?: string[] } = {}
): EvolutionCandidate[] {
  const json = extractJsonArray(response);
  if (!json) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const usedIds = new Set<string>(['baseline']);
  const candidates: EvolutionCandidate[] = [];

  parsed.forEach((raw: unknown, idx: number) => {
    if (!isRecord(raw)) return;
    const config = sanitizeCandidateConfig(raw.config, options);
    if (Object.keys(config).length === 0) return;

    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `candidate_${idx}`;
    while (usedIds.has(id)) {
      id = `${id}_${idx}`;
    }
    usedIds.add(id);

    const expectedImprovement = finiteNumber(raw.expectedImprovement);

    candidates.push({
      id,
      config,
      reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
      expectedImprovement:
        expectedImprovement !== undefined ? clamp(expectedImprovement, { min: 0, max: 1 }) : 0.5,
      risk: pickEnum(raw.risk, RISKS, 'medium'),
      generation: 0,
      score: 0,
      evaluationCount: 0,
    });
  });

  return candidates;
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
