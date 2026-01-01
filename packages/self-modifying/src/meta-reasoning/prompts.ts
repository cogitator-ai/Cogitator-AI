import type { MetaObservation, ReasoningMode, ReasoningModeConfig } from '@cogitator-ai/types';

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
      "type": "stagnation" | "repetition" | "resource_exhaustion" | "confidence_decline" | "strategy_mismatch" | "goal_drift",
      "severity": "low" | "medium" | "high" | "critical",
      "description": "string"
    }
  ],
  "opportunities": [
    {
      "type": "strategy_switch" | "temperature_adjust" | "tool_pivot" | "goal_refinement" | "context_injection",
      "description": "string",
      "expectedImprovement": number
    }
  ],
  "recommendation": {
    "action": "continue" | "switch_mode" | "adjust_parameters" | "inject_context" | "escalate" | "abort",
    "newMode": "string",
    "parameterChanges": {},
    "contextAddition": "string",
    "confidence": number,
    "reasoning": "string"
  }
}`;
}

export interface ParsedAssessment {
  onTrack: boolean;
  confidence: number;
  reasoning: string;
  issues: Array<{
    type: string;
    severity: string;
    description: string;
  }>;
  opportunities: Array<{
    type: string;
    description: string;
    expectedImprovement: number;
  }>;
  recommendation: {
    action: string;
    newMode?: string;
    parameterChanges?: Record<string, unknown>;
    contextAddition?: string;
    confidence: number;
    reasoning: string;
  };
}

export function parseMetaAssessmentResponse(content: string): ParsedAssessment | null {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as ParsedAssessment;
  } catch {
    return null;
  }
}

export const META_REASONING_SYSTEM_PROMPT = `You are a meta-reasoning system analyzing an AI agent's reasoning process.
Your job is to assess whether the agent is on track and recommend strategic adjustments.

Key responsibilities:
1. Detect when the agent is stuck, repeating itself, or making poor progress
2. Identify opportunities to improve the reasoning approach
3. Recommend mode switches or parameter adjustments when beneficial
4. Avoid over-intervention - only recommend changes when truly needed

Always respond with valid JSON matching the specified schema.`;
