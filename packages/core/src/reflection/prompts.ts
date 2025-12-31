import type { ReflectionAction, AgentContext, Insight } from '@cogitator-ai/types';

export function buildToolReflectionPrompt(
  action: ReflectionAction,
  context: AgentContext,
  relevantInsights: Insight[]
): string {
  const insightsSection =
    relevantInsights.length > 0
      ? `\nRelevant past learnings:\n${relevantInsights.map((i) => `- ${i.content}`).join('\n')}`
      : '';

  return `You just executed a tool. Analyze the result and extract learnings.

Tool: ${action.toolName}
Input: ${JSON.stringify(action.input, null, 2)}
Output: ${JSON.stringify(action.output, null, 2)}
Duration: ${action.duration ?? 'unknown'}ms
Goal: ${context.goal}
Iteration: ${context.iterationIndex + 1}
Available tools: ${context.availableTools.join(', ')}
${insightsSection}

Analyze this tool execution:
1. Was this the right tool for the task? Rate confidence 0.0-1.0
2. Did the output help progress toward the goal?
3. What alternatives could have been considered?
4. What can be learned for future similar situations?

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "wasSuccessful": boolean,
  "confidence": number,
  "reasoning": "brief explanation",
  "alternativesConsidered": ["alternative 1", "alternative 2"],
  "whatCouldImprove": "suggestion or null",
  "insights": [
    {
      "type": "pattern|mistake|success|tip|warning",
      "content": "what was learned",
      "context": "when this applies"
    }
  ]
}`;
}

export function buildErrorReflectionPrompt(
  action: ReflectionAction,
  context: AgentContext,
  relevantInsights: Insight[]
): string {
  const previousActions =
    context.previousActions.length > 0
      ? `\nPrevious actions:\n${context.previousActions
          .map((a, i) => `${i + 1}. ${a.type}${a.toolName ? `: ${a.toolName}` : ''}`)
          .join('\n')}`
      : '';

  const insightsSection =
    relevantInsights.length > 0
      ? `\nRelevant past learnings:\n${relevantInsights.map((i) => `- ${i.content}`).join('\n')}`
      : '';

  return `An error occurred during agent execution. Analyze what went wrong.

Error: ${action.error}
Action type: ${action.type}
${action.toolName ? `Tool: ${action.toolName}` : ''}
${action.input ? `Input: ${JSON.stringify(action.input, null, 2)}` : ''}
Goal: ${context.goal}
Iteration: ${context.iterationIndex + 1}
${previousActions}
${insightsSection}

Analyze this error:
1. What caused this error?
2. Could it have been prevented?
3. Is this recoverable? How?
4. What should be done differently next time?

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "wasSuccessful": false,
  "confidence": number,
  "reasoning": "what went wrong and why",
  "alternativesConsidered": ["what could have been done instead"],
  "whatCouldImprove": "specific improvement",
  "insights": [
    {
      "type": "mistake|warning|tip",
      "content": "what was learned from this error",
      "context": "when this applies"
    }
  ]
}`;
}

export function buildRunReflectionPrompt(
  context: AgentContext,
  actions: ReflectionAction[],
  finalOutput: string,
  success: boolean
): string {
  const actionsSummary = actions
    .map((a, i) => {
      const result = a.error ? `ERROR: ${a.error}` : 'OK';
      return `${i + 1}. ${a.type}${a.toolName ? `: ${a.toolName}` : ''} - ${result}`;
    })
    .join('\n');

  return `The agent run has completed. Provide an overall analysis.

Goal: ${context.goal}
Total iterations: ${context.iterationIndex + 1}
Final outcome: ${success ? 'SUCCESS' : 'FAILED'}

Actions taken:
${actionsSummary}

Final output: ${finalOutput.slice(0, 500)}${finalOutput.length > 500 ? '...' : ''}

Analyze the entire run:
1. Was the goal achieved? Rate confidence 0.0-1.0
2. What worked well?
3. What could be improved?
4. What patterns or strategies should be remembered?

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "wasSuccessful": ${success},
  "confidence": number,
  "reasoning": "overall assessment",
  "alternativesConsidered": ["what could have been done differently"],
  "whatCouldImprove": "key improvement for future runs",
  "insights": [
    {
      "type": "pattern|success|tip",
      "content": "key learning from this run",
      "context": "when to apply this"
    }
  ]
}`;
}

export interface ParsedReflection {
  wasSuccessful: boolean;
  confidence: number;
  reasoning: string;
  alternativesConsidered?: string[];
  whatCouldImprove?: string;
  insights: Array<{
    type: string;
    content: string;
    context: string;
  }>;
}

export function parseReflectionResponse(response: string): ParsedReflection | null {
  try {
    let cleaned = response.trim();

    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    const parsed = JSON.parse(cleaned) as ParsedReflection;

    if (typeof parsed.wasSuccessful !== 'boolean') {
      parsed.wasSuccessful = false;
    }
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
      parsed.confidence = 0.5;
    }
    if (typeof parsed.reasoning !== 'string') {
      parsed.reasoning = '';
    }
    if (!Array.isArray(parsed.insights)) {
      parsed.insights = [];
    }

    parsed.insights = parsed.insights.filter(
      (i) =>
        i &&
        typeof i === 'object' &&
        typeof i.type === 'string' &&
        typeof i.content === 'string' &&
        typeof i.context === 'string'
    );

    return parsed;
  } catch {
    return null;
  }
}
