import type { ThoughtNode, ThoughtBranch, ProposedAction } from '@cogitator-ai/types';

export function buildBranchGenerationPrompt(
  goal: string,
  currentNode: ThoughtNode | null,
  availableTools: string[],
  k: number,
  exploredThoughts: string[]
): string {
  const stateSection = currentNode
    ? `CURRENT STATE:
Previous thought: ${currentNode.branch.thought}
Previous action: ${JSON.stringify(currentNode.branch.proposedAction)}
Result: ${currentNode.result?.response ?? currentNode.result?.error ?? 'pending'}
Depth: ${currentNode.depth}`
    : 'CURRENT STATE: Starting fresh';

  const exploredSection = exploredThoughts.length > 0
    ? `\nALREADY EXPLORED (avoid similar approaches):\n${exploredThoughts.map(t => `- ${t}`).join('\n')}`
    : '';

  return `You are exploring different approaches to solve a problem.

GOAL: ${goal}

${stateSection}
${exploredSection}

AVAILABLE TOOLS: ${availableTools.join(', ')}

Generate exactly ${k} DIFFERENT approaches to make progress toward the goal.
Each approach should be genuinely distinct - don't just vary parameters slightly.

For each approach, provide:
1. THOUGHT: Your reasoning for this approach (2-3 sentences explaining WHY this might work)
2. ACTION: One of:
   - tool_call: Use a specific tool
   - response: Provide a direct answer
   - sub_goal: Break down into a smaller goal

Respond ONLY with valid JSON (no markdown):
{
  "branches": [
    {
      "thought": "reasoning for this approach...",
      "action": {
        "type": "tool_call",
        "toolName": "tool_name",
        "arguments": {}
      }
    },
    {
      "thought": "different reasoning...",
      "action": {
        "type": "response",
        "content": "direct answer if applicable"
      }
    }
  ]
}`;
}

export function buildBranchEvaluationPrompt(
  branch: ThoughtBranch,
  goal: string,
  siblings: ThoughtBranch[]
): string {
  const siblingsSection = siblings.length > 0
    ? `\nOTHER APPROACHES BEING CONSIDERED:\n${siblings.map(s => `- ${s.thought}`).join('\n')}`
    : '';

  return `Evaluate this approach for solving a problem.

GOAL: ${goal}

PROPOSED APPROACH:
Thought: ${branch.thought}
Action: ${JSON.stringify(branch.proposedAction)}
${siblingsSection}

Evaluate this approach on these dimensions:
1. CONFIDENCE (0.0-1.0): How likely is this approach to make progress?
2. PROGRESS (0.0-1.0): How much of the goal would this step complete?
3. NOVELTY (0.0-1.0): How different is this from the other approaches?
4. FEASIBILITY: Can this action actually be executed successfully?

Respond ONLY with valid JSON (no markdown):
{
  "confidence": 0.7,
  "progress": 0.3,
  "novelty": 0.8,
  "reasoning": "brief explanation of the evaluation"
}`;
}

export function buildSynthesisPrompt(
  goal: string,
  path: ThoughtNode[]
): string {
  const pathSummary = path.map((node, i) => {
    const result = node.result?.response ?? node.result?.error ?? 'no result';
    return `Step ${i + 1}:
  Thought: ${node.branch.thought}
  Action: ${JSON.stringify(node.branch.proposedAction)}
  Result: ${result}`;
  }).join('\n\n');

  return `Synthesize a final answer based on the explored path.

ORIGINAL GOAL: ${goal}

EXPLORATION PATH:
${pathSummary}

Based on this exploration, provide the best possible answer to the original goal.
Focus on synthesizing the insights from each step into a coherent response.

Respond with your final answer:`;
}

export interface ParsedBranches {
  branches: Array<{
    thought: string;
    action: ProposedAction;
  }>;
}

export function parseBranchResponse(response: string): ParsedBranches | null {
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

    const parsed = JSON.parse(cleaned) as ParsedBranches;

    if (!Array.isArray(parsed.branches)) {
      return null;
    }

    parsed.branches = parsed.branches.filter(b => {
      if (!b || typeof b !== 'object') return false;
      if (typeof b.thought !== 'string' || !b.thought) return false;
      if (!b.action || typeof b.action !== 'object') return false;
      if (!['tool_call', 'response', 'sub_goal'].includes(b.action.type)) return false;
      return true;
    });

    return parsed;
  } catch {
    return null;
  }
}

export interface ParsedEvaluation {
  confidence: number;
  progress: number;
  novelty: number;
  reasoning: string;
}

export function parseEvaluationResponse(response: string): ParsedEvaluation | null {
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

    const parsed = JSON.parse(cleaned) as ParsedEvaluation;

    const clamp = (n: number) => Math.max(0, Math.min(1, n));

    return {
      confidence: typeof parsed.confidence === 'number' ? clamp(parsed.confidence) : 0.5,
      progress: typeof parsed.progress === 'number' ? clamp(parsed.progress) : 0.3,
      novelty: typeof parsed.novelty === 'number' ? clamp(parsed.novelty) : 0.5,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch {
    return null;
  }
}
