import type { ExecutionTrace, InstructionGap, Insight } from '@cogitator-ai/types';

export function buildFailureAnalysisPrompt(
  traces: ExecutionTrace[],
  currentInstructions: string
): string {
  const failedTraces = traces.filter((t) => !t.metrics.success || t.score < 0.7);

  const traceSummaries = failedTraces
    .slice(0, 5)
    .map(
      (t, i) => `
Trace ${i + 1}:
- Input: ${t.input.slice(0, 200)}${t.input.length > 200 ? '...' : ''}
- Output: ${t.output.slice(0, 200)}${t.output.length > 200 ? '...' : ''}
- Score: ${t.score.toFixed(2)}
- Tools used: ${t.toolCalls.map((tc) => tc.name).join(', ') || 'none'}
- Error: ${t.steps.find((s) => s.toolResult?.error)?.toolResult?.error ?? 'none'}
`
    )
    .join('\n');

  return `Analyze these failed agent executions to identify instruction gaps.

Current Instructions:
${currentInstructions}

Failed Executions:
${traceSummaries}

Identify patterns in the failures. What's missing from the instructions that caused these issues?

Respond with JSON:
{
  "gaps": [
    {
      "description": "What the agent should have done differently",
      "frequency": 1-5,
      "suggestedFix": "Specific instruction to add or modify"
    }
  ],
  "overallAnalysis": "Brief summary of the main issues"
}`;
}

export function buildInstructionCandidatePrompt(
  currentInstructions: string,
  gaps: InstructionGap[],
  insights: Insight[]
): string {
  const gapsList = gaps
    .map(
      (g, i) => `${i + 1}. ${g.description} (frequency: ${g.frequency})\n   Fix: ${g.suggestedFix}`
    )
    .join('\n');

  const insightsList = insights
    .slice(0, 5)
    .map((ins, i) => `${i + 1}. [${ins.type}] ${ins.content}`)
    .join('\n');

  return `Generate improved agent instructions based on identified gaps and learnings.

Current Instructions:
${currentInstructions}

Identified Gaps:
${gapsList}

Past Learnings:
${insightsList || 'None available'}

Generate 3 different improved versions of the instructions. Each should:
1. Address the identified gaps
2. Incorporate relevant learnings
3. Be clear, specific, and actionable
4. Not be too long (similar length to original)

Respond with JSON:
{
  "candidates": [
    {
      "instructions": "Full improved instructions text",
      "reasoning": "Why this version is better"
    }
  ]
}`;
}

export function buildInstructionEvaluationPrompt(
  candidate: string,
  traces: ExecutionTrace[]
): string {
  const traceSummaries = traces
    .slice(0, 3)
    .map(
      (t, i) => `
Example ${i + 1}:
- Input: ${t.input.slice(0, 150)}
- Expected behavior: ${t.metrics.success ? 'Success' : 'Should have succeeded'}
`
    )
    .join('\n');

  return `Evaluate if these instructions would have helped the agent perform better.

Instructions to evaluate:
${candidate}

Example scenarios where the agent struggled:
${traceSummaries}

Would these instructions help the agent handle these scenarios better?

Respond with JSON:
{
  "score": 0.0-1.0,
  "strengths": ["What's good about these instructions"],
  "weaknesses": ["What could still be improved"],
  "reasoning": "Overall assessment"
}`;
}

export function buildInstructionRefinementPrompt(candidate: string, feedback: string[]): string {
  return `Refine these agent instructions based on feedback.

Current Version:
${candidate}

Feedback:
${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Create an improved version that addresses the feedback while keeping the good parts.

Respond with JSON:
{
  "instructions": "Refined instructions text",
  "changes": ["List of changes made"]
}`;
}

export interface FailureAnalysisResult {
  gaps: InstructionGap[];
  overallAnalysis: string;
}

export function parseFailureAnalysisResponse(content: string): FailureAnalysisResult | null {
  try {
    let jsonStr = content;
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(content);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    const parsed = JSON.parse(jsonStr);

    const gaps: InstructionGap[] = (parsed.gaps ?? [])
      .filter((g: unknown) => g && typeof g === 'object' && 'description' in g)
      .map((g: Record<string, unknown>) => ({
        description: String(g.description ?? ''),
        frequency: Math.min(5, Math.max(1, Number(g.frequency) || 1)),
        exampleTraces: [],
        suggestedFix: String(g.suggestedFix ?? ''),
      }));

    return {
      gaps,
      overallAnalysis: String(parsed.overallAnalysis ?? ''),
    };
  } catch {
    return null;
  }
}

export interface InstructionCandidate {
  instructions: string;
  reasoning: string;
}

export function parseInstructionCandidatesResponse(content: string): InstructionCandidate[] {
  try {
    let jsonStr = content;
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(content);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    const parsed = JSON.parse(jsonStr);

    return (parsed.candidates ?? [])
      .filter((c: unknown) => c && typeof c === 'object' && 'instructions' in c)
      .map((c: Record<string, unknown>) => ({
        instructions: String(c.instructions ?? ''),
        reasoning: String(c.reasoning ?? ''),
      }));
  } catch {
    return [];
  }
}

export interface InstructionEvaluation {
  score: number;
  strengths: string[];
  weaknesses: string[];
  reasoning: string;
}

export function parseInstructionEvaluationResponse(content: string): InstructionEvaluation | null {
  try {
    let jsonStr = content;
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(content);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    const parsed = JSON.parse(jsonStr);

    return {
      score: Math.max(0, Math.min(1, Number(parsed.score) || 0.5)),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map(String) : [],
      reasoning: String(parsed.reasoning ?? ''),
    };
  } catch {
    return null;
  }
}

export interface InstructionRefinement {
  instructions: string;
  changes: string[];
}

export function parseInstructionRefinementResponse(content: string): InstructionRefinement | null {
  try {
    let jsonStr = content;
    const codeBlockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(content);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    }

    const parsed = JSON.parse(jsonStr);

    return {
      instructions: String(parsed.instructions ?? ''),
      changes: Array.isArray(parsed.changes) ? parsed.changes.map(String) : [],
    };
  } catch {
    return null;
  }
}
