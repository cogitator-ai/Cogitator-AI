import type {
  Plan,
  PlanAction,
  PlanState,
  ActionSchema,
  PlanValidationResult,
  PlanRepairResult,
  InvariantCheckResult,
} from '@cogitator-ai/types';
import { schemaToString, actionToString, preconditionToString } from './action-schema';
import { formatValidationResult } from './plan-validator';
import { formatInvariantResults } from './invariant-checker';

export interface PlanGenerationContext {
  goal: string;
  initialState: Record<string, unknown>;
  availableActions: ActionSchema[];
  constraints?: string[];
}

export function createPlanGenerationPrompt(ctx: PlanGenerationContext): string {
  const actionsStr = ctx.availableActions.map(schemaToString).join('\n\n');
  const stateStr = Object.entries(ctx.initialState)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
    .join('\n');

  const constraintsStr = ctx.constraints?.length
    ? `\n\nConstraints:\n${ctx.constraints.map((c) => `  - ${c}`).join('\n')}`
    : '';

  return `You are a planning expert. Generate a plan to achieve the given goal.

Goal: ${ctx.goal}

Initial State:
${stateStr}

Available Actions:
${actionsStr}${constraintsStr}

Generate a sequence of actions to achieve the goal. Respond with JSON:
{
  "plan": [
    {
      "action": "action_name",
      "parameters": { "param1": "value1", ... }
    }
  ],
  "explanation": "Brief explanation of the plan"
}

JSON:`;
}

export interface PlanValidationPromptContext {
  plan: Plan;
  validationResult: PlanValidationResult;
  availableActions: ActionSchema[];
}

export function createValidationExplanationPrompt(ctx: PlanValidationPromptContext): string {
  const planStr = ctx.plan.actions.map((a, i) => `${i + 1}. ${actionToString(a)}`).join('\n');
  const validationStr = formatValidationResult(ctx.validationResult);

  return `Explain the validation results for the following plan:

Plan:
${planStr}

Validation Results:
${validationStr}

Provide a clear explanation of:
1. What the plan is trying to achieve
2. Why it passed or failed validation
3. If it failed, what went wrong and how to fix it`;
}

export interface PlanRepairPromptContext {
  plan: Plan;
  repairResult: PlanRepairResult;
  availableActions: ActionSchema[];
}

export function createRepairExplanationPrompt(ctx: PlanRepairPromptContext): string {
  const originalPlanStr = ctx.plan.actions
    .map((a, i) => `${i + 1}. ${actionToString(a)}`)
    .join('\n');

  const repairedPlanStr = ctx.repairResult.repairedPlan
    ? ctx.repairResult.repairedPlan.actions
        .map((a, i) => `${i + 1}. ${actionToString(a)}`)
        .join('\n')
    : 'No repaired plan generated';

  const suggestionsStr = ctx.repairResult.suggestions
    .map((s) => `- ${s.type}: ${s.reason} (${(s.confidence * 100).toFixed(0)}% confidence)`)
    .join('\n');

  return `Explain the plan repair process:

Original Plan:
${originalPlanStr}

Repaired Plan:
${repairedPlanStr}

Repair Suggestions:
${suggestionsStr}

Repair ${ctx.repairResult.success ? 'succeeded' : 'failed'}.

Explain:
1. What was wrong with the original plan
2. How it was fixed (or why it couldn't be fixed)
3. Why the suggested repairs make sense`;
}

export interface InvariantViolationContext {
  plan: Plan;
  invariantResults: InvariantCheckResult[];
}

export function createInvariantViolationPrompt(ctx: InvariantViolationContext): string {
  const planStr = ctx.plan.actions.map((a, i) => `${i + 1}. ${actionToString(a)}`).join('\n');
  const resultsStr = formatInvariantResults(ctx.invariantResults);

  return `Explain the safety property violations in the following plan:

Plan:
${planStr}

Safety Check Results:
${resultsStr}

Explain:
1. Which safety properties were violated
2. Why they were violated
3. What changes would prevent the violations`;
}

export interface ActionSuggestionContext {
  currentState: PlanState;
  goalDescription: string;
  availableActions: ActionSchema[];
  actionsAlreadyTaken?: PlanAction[];
}

export function createActionSuggestionPrompt(ctx: ActionSuggestionContext): string {
  const stateStr = Object.entries(ctx.currentState.variables)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
    .join('\n');

  const actionsStr = ctx.availableActions.map(schemaToString).join('\n\n');

  const historyStr = ctx.actionsAlreadyTaken?.length
    ? `\nActions already taken:\n${ctx.actionsAlreadyTaken.map((a, i) => `${i + 1}. ${actionToString(a)}`).join('\n')}`
    : '';

  return `Given the current state and goal, suggest the next best action.

Current State:
${stateStr}

Goal: ${ctx.goalDescription}${historyStr}

Available Actions:
${actionsStr}

Suggest the next action and explain why. Respond with JSON:
{
  "action": "action_name",
  "parameters": { "param1": "value1", ... },
  "reasoning": "Why this action is the best choice"
}

JSON:`;
}

export interface ParsePlanResult {
  plan: Array<{ action: string; parameters: Record<string, unknown> }>;
  explanation?: string;
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

export function parsePlanResponse(response: string): ParsePlanResult | null {
  try {
    const jsonStr = extractJSON(response);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    return {
      plan: (Array.isArray(parsed.plan) ? parsed.plan : [])
        .filter(
          (item: unknown) =>
            item && typeof item === 'object' && 'action' in (item as Record<string, unknown>)
        )
        .map((item: Record<string, unknown>) => ({
          action: String(item.action || ''),
          parameters:
            item.parameters && typeof item.parameters === 'object'
              ? (item.parameters as Record<string, unknown>)
              : {},
        })),
      explanation: parsed.explanation,
    };
  } catch {
    return null;
  }
}

export interface ParseActionSuggestionResult {
  action: string;
  parameters: Record<string, unknown>;
  reasoning: string;
}

export function parseActionSuggestionResponse(
  response: string
): ParseActionSuggestionResult | null {
  try {
    const jsonStr = extractJSON(response);
    if (!jsonStr) return null;

    const parsed = JSON.parse(jsonStr);

    return {
      action: String(parsed.action || ''),
      parameters: (parsed.parameters as Record<string, unknown>) || {},
      reasoning: String(parsed.reasoning || ''),
    };
  } catch {
    return null;
  }
}

export function formatPlanForPrompt(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`Plan: ${plan.name || plan.id}`);
  lines.push('');

  lines.push('Initial State:');
  for (const [k, v] of Object.entries(plan.initialState.variables)) {
    lines.push(`  ${k} = ${JSON.stringify(v)}`);
  }
  lines.push('');

  lines.push('Actions:');
  for (let i = 0; i < plan.actions.length; i++) {
    lines.push(`  ${i + 1}. ${actionToString(plan.actions[i])}`);
  }
  lines.push('');

  lines.push('Goals:');
  for (const goal of plan.goalConditions) {
    lines.push(`  - ${preconditionToString(goal)}`);
  }

  return lines.join('\n');
}

export function formatStateForPrompt(state: PlanState): string {
  return Object.entries(state.variables)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join('\n');
}

export function formatActionsForPrompt(actions: ActionSchema[]): string {
  return actions.map(schemaToString).join('\n\n');
}
