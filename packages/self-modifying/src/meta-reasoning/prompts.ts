import type {
  MetaIssue,
  MetaObservation,
  MetaOpportunity,
  MetaRecommendation,
  ReasoningMode,
  ReasoningModeConfig,
} from '@cogitator-ai/types';
import { extractJson } from '../utils';

export function buildMetaAssessmentPrompt(
  observation: MetaObservation,
  context: {
    allowedModes: ReasoningMode[];
    currentModeConfig: ReasoningModeConfig;
  }
): string {
  return `# Meta-Reasoning Assessment

## Current Goal
${observation.goal}

## Current Reasoning Mode
Mode: ${observation.currentMode}
Temperature: ${context.currentModeConfig.temperature}
Iterations remaining: ${observation.iterationsRemaining}

## Progress Metrics
- Progress score: ${(observation.progressScore * 100).toFixed(1)}%
- Progress delta (last step): ${observation.progressDelta > 0 ? '+' : ''}${(observation.progressDelta * 100).toFixed(1)}%
- Stagnation count: ${observation.stagnationCount} consecutive low-progress iterations

## Confidence Metrics
- Current confidence: ${(observation.currentConfidence * 100).toFixed(1)}%
- Trend: ${observation.confidenceTrend}
- History: [${observation.confidenceHistory.map((c) => (c * 100).toFixed(0) + '%').join(', ')}]

## Resource Usage
- Tokens used: ${observation.tokensUsed}
- Time elapsed: ${observation.timeElapsed}ms
- Budget remaining: ${((observation.budgetRemaining ?? 0) * 100).toFixed(1)}%

## Quality Metrics
- Tool success rate: ${(observation.toolSuccessRate * 100).toFixed(1)}%
- Repetition score: ${(observation.repetitionScore * 100).toFixed(1)}% (lower is better)

## Recent Actions
${(observation.recentActions ?? []).map((a) => `- ${a.type}: ${a.toolName ?? 'N/A'} ${a.error ? '(ERROR: ' + a.error + ')' : ''}`).join('\n') || 'None'}

## Recent Insights
${
  (observation.recentInsights ?? ([] as Array<{ type?: string; content?: string }>))
    .map((i) => {
      const insight = i as { type?: string; content?: string };
      return `- [${insight.type ?? 'insight'}] ${insight.content ?? ''}`;
    })
    .join('\n') || 'None'
}

## Available Modes for Switching
${context.allowedModes.map((m) => `- ${m}`).join('\n')}

---

Analyze the agent's reasoning process and respond with a JSON object:

{
  "onTrack": boolean,
  "confidence": number,
  "reasoning": "string",
  "issues": [
    {
      "type": "stagnation" | "low_confidence" | "high_cost" | "repetition" | "tool_failure",
      "severity": "low" | "medium" | "high",
      "description": "string"
    }
  ],
  "opportunities": [
    {
      "type": "mode_switch" | "parameter_tune" | "context_add" | "tool_compose",
      "description": "string",
      "expectedImprovement": number
    }
  ],
  "recommendation": {
    "action": "continue" | "switch_mode" | "adjust_parameters" | "inject_context" | "abort",
    "newMode": "string",
    "parameterChanges": {},
    "contextAddition": "string",
    "confidence": number,
    "reasoning": "string"
  }
}`;
}

const REASONING_MODES: readonly ReasoningMode[] = [
  'analytical',
  'creative',
  'systematic',
  'intuitive',
  'reflective',
  'exploratory',
];
const ISSUE_TYPES: readonly MetaIssue['type'][] = [
  'stagnation',
  'low_confidence',
  'high_cost',
  'repetition',
  'tool_failure',
];
const SEVERITIES: readonly MetaIssue['severity'][] = ['low', 'medium', 'high'];
const OPPORTUNITY_TYPES: readonly MetaOpportunity['type'][] = [
  'mode_switch',
  'parameter_tune',
  'context_add',
  'tool_compose',
];
const ACTIONS: readonly MetaRecommendation['action'][] = [
  'continue',
  'switch_mode',
  'adjust_parameters',
  'inject_context',
  'abort',
];

export interface ParsedAssessment {
  onTrack?: boolean;
  confidence?: number;
  reasoning?: string;
  issues: MetaIssue[];
  opportunities: Array<{
    type: MetaOpportunity['type'];
    description: string;
    expectedImprovement: number;
  }>;
  recommendation?: {
    action: MetaRecommendation['action'];
    newMode?: ReasoningMode;
    parameterChanges?: Partial<ReasoningModeConfig>;
    contextAddition?: string;
    confidence: number;
    reasoning: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function probability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

function parseParameterChanges(value: unknown): Partial<ReasoningModeConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const changes: Partial<ReasoningModeConfig> = {};
  if (typeof value.temperature === 'number' && Number.isFinite(value.temperature)) {
    changes.temperature = Math.min(2, Math.max(0, value.temperature));
  }
  if (typeof value.depth === 'number' && Number.isFinite(value.depth)) {
    changes.depth = Math.min(10, Math.max(1, Math.round(value.depth)));
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

function parseRecommendation(value: unknown): ParsedAssessment['recommendation'] {
  if (!isRecord(value)) return undefined;
  const action = pick(value.action, ACTIONS);
  if (!action) return undefined;

  return {
    action,
    newMode: pick(value.newMode, REASONING_MODES),
    parameterChanges: parseParameterChanges(value.parameterChanges),
    contextAddition:
      typeof value.contextAddition === 'string' && value.contextAddition.trim()
        ? value.contextAddition.trim()
        : undefined,
    confidence: probability(value.confidence) ?? 0,
    reasoning: typeof value.reasoning === 'string' ? value.reasoning : '',
  };
}

export function parseMetaAssessmentResponse(content: string): ParsedAssessment | null {
  let parsed: unknown;
  try {
    const json = extractJson(content);
    if (!json) return null;
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const issues: MetaIssue[] = [];
  for (const raw of Array.isArray(parsed.issues) ? parsed.issues : []) {
    if (!isRecord(raw)) continue;
    const type = pick(raw.type, ISSUE_TYPES);
    if (!type) continue;
    issues.push({
      type,
      severity: pick(raw.severity, SEVERITIES) ?? 'medium',
      description: typeof raw.description === 'string' ? raw.description : '',
    });
  }

  const opportunities: ParsedAssessment['opportunities'] = [];
  for (const raw of Array.isArray(parsed.opportunities) ? parsed.opportunities : []) {
    if (!isRecord(raw)) continue;
    const type = pick(raw.type, OPPORTUNITY_TYPES);
    if (!type) continue;
    opportunities.push({
      type,
      description: typeof raw.description === 'string' ? raw.description : '',
      expectedImprovement: probability(raw.expectedImprovement) ?? 0.5,
    });
  }

  return {
    onTrack: typeof parsed.onTrack === 'boolean' ? parsed.onTrack : undefined,
    confidence: probability(parsed.confidence),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
    issues,
    opportunities,
    recommendation: parseRecommendation(parsed.recommendation),
  };
}

export const META_REASONING_SYSTEM_PROMPT = `You are a meta-reasoning system analyzing an AI agent's reasoning process.
Your job is to assess whether the agent is on track and recommend strategic adjustments.

Key responsibilities:
1. Detect when the agent is stuck, repeating itself, or making poor progress
2. Identify opportunities to improve the reasoning approach
3. Recommend mode switches or parameter adjustments when beneficial
4. Avoid over-intervention - only recommend changes when truly needed

Always respond with valid JSON matching the specified schema.`;
