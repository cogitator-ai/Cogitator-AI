import { z } from 'zod';
import type { ToolContext, Plan, PlanState, PlanAction, Precondition } from '@cogitator-ai/types';
import { tool } from '@cogitator-ai/core';
import { nanoid } from 'nanoid';
import type { NeuroSymbolic } from '../orchestrator';

const actionInputSchema = z.object({
  name: z.string().describe('Action schema name'),
  parameters: z.record(z.string(), z.unknown()).describe('Action parameters'),
});

const planInputSchema = z.object({
  actions: z.array(actionInputSchema).describe('Sequence of actions in the plan'),
  initialState: z.record(z.string(), z.unknown()).describe('Initial state variables'),
  goals: z.array(z.string()).describe('Goal conditions as variable names that should be true'),
});

export function createPlanningTools(ns: NeuroSymbolic) {
  const validatePlan = tool({
    name: 'validate_plan',
    description:
      'Validate a plan against registered action schemas. ' +
      'Checks preconditions, effects, and goal satisfaction. ' +
      'Returns detailed validation results with errors and warnings.',
    category: 'development',
    tags: ['planning', 'validation', 'verification', 'neuro-symbolic'],
    parameters: z.object({
      plan: planInputSchema,
    }),
    execute: async ({ plan: planInput }, _context: ToolContext) => {
      const plan = convertToPlan(planInput);
      const result = ns.validatePlan(plan);

      if (!result.success || !result.data) {
        return {
          valid: false,
          error: result.error || 'Validation failed',
        };
      }

      const validation = result.data;

      return {
        valid: validation.valid,
        errors: validation.errors.map((e) => ({
          type: e.type,
          action: e.actionName,
          actionIndex: e.actionIndex,
          message: e.message,
        })),
        warnings: validation.warnings.map((w) => ({
          type: w.type,
          actionIndex: w.actionIndex,
          message: w.message,
        })),
        satisfiedGoals: validation.satisfiedGoals,
        unsatisfiedGoals: validation.unsatisfiedGoals,
        stateCount: validation.stateTrace.length,
        duration: result.duration,
      };
    },
  });

  const repairPlan = tool({
    name: 'repair_plan',
    description:
      'Attempt to repair an invalid plan by inserting, removing, or reordering actions. ' +
      'Returns repair suggestions and the repaired plan if successful.',
    category: 'development',
    tags: ['planning', 'repair', 'verification', 'neuro-symbolic'],
    parameters: z.object({
      plan: planInputSchema,
    }),
    execute: async ({ plan: planInput }, _context: ToolContext) => {
      const plan = convertToPlan(planInput);
      const result = ns.repairPlan(plan);

      if (!result.success || !result.data) {
        return {
          success: false,
          error: result.error || 'Repair failed',
        };
      }

      const repair = result.data;

      return {
        success: repair.success,
        suggestions: repair.suggestions.map((s) => ({
          type: s.type,
          position: s.position,
          reason: s.reason,
          confidence: s.confidence,
          action: s.action
            ? {
                name: s.action.schemaName,
                parameters: s.action.parameters,
              }
            : undefined,
        })),
        repairedPlan: repair.repairedPlan
          ? {
              actions: repair.repairedPlan.actions.map((a) => ({
                name: a.schemaName,
                parameters: a.parameters,
              })),
            }
          : undefined,
        explanation: repair.explanation,
        duration: result.duration,
      };
    },
  });

  const registerAction = tool({
    name: 'register_action',
    description:
      'Register an action schema for plan validation. ' +
      'Define preconditions and effects for actions that can be used in plans.',
    category: 'development',
    tags: ['planning', 'schema', 'neuro-symbolic'],
    parameters: z.object({
      name: z.string().describe('Action name'),
      description: z.string().optional().describe('Action description'),
      parameters: z
        .array(
          z.object({
            name: z.string(),
            type: z.string(),
            required: z.boolean().optional(),
          })
        )
        .describe('Action parameters'),
      preconditions: z
        .array(
          z.object({
            variable: z.string(),
            value: z.unknown(),
          })
        )
        .describe('Required state before action'),
      effects: z
        .array(
          z.object({
            variable: z.string(),
            value: z.unknown(),
          })
        )
        .describe('State changes after action'),
      cost: z.number().optional().describe('Action cost'),
    }),
    execute: async (
      { name, description, parameters, preconditions, effects, cost },
      _context: ToolContext
    ) => {
      const actionSchema = {
        name,
        description,
        parameters: parameters.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required ?? true,
        })),
        preconditions: preconditions.map(
          (p): Precondition => ({
            type: 'simple' as const,
            variable: p.variable,
            value: p.value,
          })
        ),
        effects: effects.map((e) => ({
          type: 'assign' as const,
          variable: e.variable,
          value: e.value,
        })),
        cost,
      };

      ns.registerAction(actionSchema);

      const registry = ns.getActionRegistry();
      const allActions = registry.getAll();

      return {
        success: true,
        registeredAction: name,
        totalActions: allActions.length,
        actionNames: allActions.map((a) => a.name),
      };
    },
  });

  return { validatePlan, repairPlan, registerAction };
}

function convertToPlan(input: {
  actions: { name: string; parameters: Record<string, unknown> }[];
  initialState: Record<string, unknown>;
  goals: string[];
}): Plan {
  const actions: PlanAction[] = input.actions.map((a, i) => ({
    id: `action-${i}-${nanoid(6)}`,
    schemaName: a.name,
    parameters: a.parameters,
  }));

  const initialState: PlanState = {
    id: 'initial',
    variables: input.initialState,
  };

  const goalConditions: Precondition[] = input.goals.map((g) => ({
    type: 'simple' as const,
    variable: g,
    value: true,
  }));

  return {
    id: `plan-${nanoid(8)}`,
    actions,
    initialState,
    goalConditions,
  };
}
