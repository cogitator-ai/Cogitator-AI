import type { ConstraintProblem, SolverResult } from '@cogitator-ai/types';
import { constraintToString, problemToString, expressionToString } from './dsl';

export interface NLToConstraintsContext {
  description: string;
  variableHints?: string[];
  domain?: string;
}

export function createNLToConstraintsPrompt(ctx: NLToConstraintsContext): string {
  const hints = ctx.variableHints?.length
    ? `\nVariable hints: ${ctx.variableHints.join(', ')}`
    : '';

  const domain = ctx.domain ? `\nDomain context: ${ctx.domain}` : '';

  return `You are a constraint programming expert. Convert the following natural language problem description into a constraint satisfaction problem.

Problem description:
"${ctx.description}"${hints}${domain}

Respond with a JSON object:
{
  "variables": [
    {
      "name": "variable_name",
      "type": "bool" | "int" | "real",
      "domain": { "min": number, "max": number }
    }
  ],
  "constraints": [
    {
      "description": "human-readable description",
      "expression": "variable expression using: ==, !=, <, >, <=, >=, +, -, *, /, &&, ||, !"
    }
  ],
  "objective": {
    "type": "minimize" | "maximize",
    "expression": "expression to optimize"
  }
}

JSON:`;
}

export interface ConstraintExplanationContext {
  problem: ConstraintProblem;
  result: SolverResult;
}

export function createConstraintExplanationPrompt(ctx: ConstraintExplanationContext): string {
  const problemStr = problemToString(ctx.problem);

  let resultStr: string;
  if (ctx.result.status === 'sat') {
    const assignments = Object.entries(ctx.result.model.assignments)
      .map(([k, v]) => `  ${k} = ${v}`)
      .join('\n');
    resultStr = `Status: Satisfiable\n\nAssignments:\n${assignments}`;
    if (ctx.result.model.objectiveValue !== undefined) {
      resultStr += `\n\nObjective value: ${ctx.result.model.objectiveValue}`;
    }
  } else if (ctx.result.status === 'unsat') {
    resultStr = 'Status: Unsatisfiable - No solution exists that satisfies all constraints.';
  } else if (ctx.result.status === 'timeout') {
    resultStr = 'Status: Timeout - The solver ran out of time.';
  } else if (ctx.result.status === 'unknown') {
    resultStr = `Status: Unknown - ${ctx.result.reason}`;
  } else {
    resultStr = `Status: Error - ${ctx.result.message}`;
  }

  return `Explain the following constraint satisfaction problem and its solution in natural language.

${problemStr}

Result:
${resultStr}

Provide a clear explanation of:
1. What the problem is asking for
2. What the variables represent
3. What constraints must be satisfied
4. Why the given solution works (or why no solution exists)`;
}

export interface UnsatAnalysisContext {
  problem: ConstraintProblem;
  unsatCore?: string[];
}

export function createUnsatAnalysisPrompt(ctx: UnsatAnalysisContext): string {
  const problemStr = problemToString(ctx.problem);

  const coreInfo = ctx.unsatCore?.length
    ? `\nUnsatisfiable core (conflicting constraints):\n${ctx.unsatCore
        .map((id) => {
          const constraint = ctx.problem.constraints.find((c) => c.id === id);
          return constraint ? `  - ${constraintToString(constraint)}` : `  - ${id}`;
        })
        .join('\n')}`
    : '';

  return `The following constraint satisfaction problem is unsatisfiable. Analyze why and suggest how to fix it.

${problemStr}${coreInfo}

Analyze:
1. Which constraints are in conflict
2. Why they cannot all be satisfied simultaneously
3. Suggestions for relaxing or modifying constraints to make the problem solvable`;
}

export interface ConstraintSuggestionContext {
  partialProblem: string;
  goal: string;
}

export function createConstraintSuggestionPrompt(ctx: ConstraintSuggestionContext): string {
  return `Given a partial constraint problem and a goal, suggest additional constraints or variables that would help achieve the goal.

Current problem:
${ctx.partialProblem}

Goal:
${ctx.goal}

Suggest:
1. Additional variables if needed
2. Additional constraints to achieve the goal
3. Optimization objective if applicable

Provide suggestions in the same JSON format as before.`;
}

export interface ParseNLConstraintsResult {
  variables: Array<{
    name: string;
    type: 'bool' | 'int' | 'real';
    domain?: { min?: number; max?: number };
  }>;
  constraints: Array<{
    description: string;
    expression: string;
  }>;
  objective?: {
    type: 'minimize' | 'maximize';
    expression: string;
  };
}

function extractJSON(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const VALID_VAR_TYPES = new Set(['bool', 'int', 'real']);

export function parseNLConstraintsResponse(response: string): ParseNLConstraintsResult | null {
  try {
    const jsonStr = extractJSON(response);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    return {
      variables: (parsed.variables || []).map((v: Record<string, unknown>) => ({
        name: String(v.name || ''),
        type: VALID_VAR_TYPES.has(String(v.type)) ? (v.type as 'bool' | 'int' | 'real') : 'int',
        domain: v.domain as { min?: number; max?: number } | undefined,
      })),
      constraints: (parsed.constraints || []).map((c: Record<string, unknown>) => ({
        description: String(c.description || ''),
        expression: String(c.expression || ''),
      })),
      objective: parsed.objective
        ? {
            type: parsed.objective.type as 'minimize' | 'maximize',
            expression: String(parsed.objective.expression),
          }
        : undefined,
    };
  } catch {
    return null;
  }
}

export function formatSolverResultForLLM(result: SolverResult): string {
  switch (result.status) {
    case 'sat': {
      const lines = ['Solution found:'];
      for (const [name, value] of Object.entries(result.model.assignments)) {
        lines.push(`  ${name} = ${value}`);
      }
      if (result.model.objectiveValue !== undefined) {
        lines.push(`  Objective value: ${result.model.objectiveValue}`);
      }
      return lines.join('\n');
    }

    case 'unsat':
      return 'No solution exists - the constraints are contradictory.';

    case 'timeout':
      return 'The solver timed out before finding a solution.';

    case 'unknown':
      return `Solver returned unknown: ${result.reason}`;

    case 'error':
      return `Solver error: ${result.message}`;
  }
}

export function formatProblemSummary(problem: ConstraintProblem): string {
  const varTypes = problem.variables.reduce(
    (acc, v) => {
      acc[v.type] = (acc[v.type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const typeStr = Object.entries(varTypes)
    .map(([t, c]) => `${c} ${t}`)
    .join(', ');

  const hardCount = problem.constraints.filter((c) => c.isHard).length;
  const softCount = problem.constraints.length - hardCount;

  let summary = `Problem: ${problem.name || 'Unnamed'}\n`;
  summary += `Variables: ${problem.variables.length} (${typeStr})\n`;
  summary += `Constraints: ${hardCount} hard, ${softCount} soft\n`;

  if (problem.objective) {
    summary += `Objective: ${problem.objective.type} ${expressionToString(problem.objective.expression)}`;
  }

  return summary;
}
