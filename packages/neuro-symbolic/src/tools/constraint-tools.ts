import { z } from 'zod';
import type { ToolContext } from '@cogitator-ai/types';
import { tool } from '@cogitator-ai/core';
import type { NeuroSymbolic } from '../orchestrator';
import { ConstraintBuilder, Expr, isZ3Available, constant } from '../constraints';

let cachedZ3Available: boolean | undefined;

async function getZ3Available(): Promise<boolean> {
  cachedZ3Available ??= await isZ3Available();
  return cachedZ3Available;
}

const variableSchema = z.object({
  name: z.string().describe('Variable name'),
  type: z.enum(['bool', 'int', 'real']).describe('Variable type'),
  min: z.number().optional().describe('Minimum value for int/real'),
  max: z.number().optional().describe('Maximum value for int/real'),
});

const constraintExprSchema = z.object({
  left: z.string().describe('Left operand (variable name or number)'),
  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'and', 'or', 'implies']).describe('Operator'),
  right: z.string().describe('Right operand (variable name or number)'),
});

export function createConstraintTools(ns: NeuroSymbolic) {
  const solveConstraints = tool({
    name: 'solve_constraints',
    description:
      'Solve a constraint satisfaction problem (CSP) using SAT/SMT solver. ' +
      'Define variables with domains and constraints between them. ' +
      'Returns satisfying assignments or indicates unsatisfiability.',
    category: 'development' as const,
    tags: ['constraints', 'sat', 'smt', 'z3', 'neuro-symbolic'],
    parameters: z.object({
      problemName: z.string().optional().describe('Optional name for the problem'),
      variables: z.array(variableSchema).describe('Variables to solve for'),
      constraints: z.array(constraintExprSchema).describe('Constraints between variables'),
      objective: z
        .object({
          type: z.enum(['minimize', 'maximize']),
          variable: z.string().describe('Variable to optimize'),
        })
        .optional()
        .describe('Optimization objective'),
    }),
    execute: async (
      { problemName, variables: varDefs, constraints: constraintDefs, objective },
      _context: ToolContext
    ) => {
      const builder = ConstraintBuilder.create(problemName);

      try {
        const varExprs = new Map<string, Expr>();

        for (const v of varDefs) {
          const expr =
            v.type === 'bool'
              ? builder.bool(v.name)
              : v.type === 'int'
                ? builder.int(v.name, v.min ?? 0, v.max ?? 100)
                : builder.real(v.name, v.min ?? 0, v.max ?? 100);
          varExprs.set(v.name, expr);
        }

        for (const c of constraintDefs) {
          builder.assert(
            applyOperator(c.op, parseOperand(c.left, varExprs), parseOperand(c.right, varExprs))
          );
        }

        if (objective) {
          const objExpr = varExprs.get(objective.variable);
          if (!objExpr) {
            throw new Error(
              `Objective variable '${objective.variable}' not found in declared variables`
            );
          }
          if (objective.type === 'minimize') {
            builder.minimize(objExpr);
          } else {
            builder.maximize(objExpr);
          }
        }
      } catch (err) {
        return {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const problem = builder.build();
      const result = await ns.solve(problem);

      const z3Available = await getZ3Available();

      if (!result.data) {
        return {
          status: 'error',
          error: result.error || 'Solver returned no data',
          z3Available,
        };
      }

      const solverResult = result.data;

      switch (solverResult.status) {
        case 'sat':
          return {
            status: 'sat',
            satisfiable: true,
            model: solverResult.model.assignments,
            objectiveValue: solverResult.model.objectiveValue,
            duration: result.duration,
            z3Available,
          };

        case 'unsat':
          return {
            status: 'unsat',
            satisfiable: false,
            unsatCore: solverResult.unsatCore,
            duration: result.duration,
            z3Available,
          };

        case 'timeout':
          return {
            status: 'timeout',
            satisfiable: null,
            duration: result.duration,
            z3Available,
          };

        case 'unknown':
          return {
            status: 'unknown',
            satisfiable: null,
            reason: solverResult.reason,
            duration: result.duration,
            z3Available,
          };

        default:
          return {
            status: 'error',
            error: solverResult.message,
            duration: result.duration,
            z3Available,
          };
      }
    },
  });

  return { solveConstraints };
}

type ConstraintOp = z.infer<typeof constraintExprSchema>['op'];

function applyOperator(op: ConstraintOp, left: Expr, right: Expr): Expr {
  switch (op) {
    case 'eq':
      return left.eq(right);
    case 'neq':
      return left.neq(right);
    case 'gt':
      return left.gt(right);
    case 'gte':
      return left.gte(right);
    case 'lt':
      return left.lt(right);
    case 'lte':
      return left.lte(right);
    case 'and':
      return left.and(right);
    case 'or':
      return left.or(right);
    case 'implies':
      return left.implies(right);
  }
}

function parseOperand(operand: string, varExprs: Map<string, Expr>): Expr {
  const trimmed = operand.trim();
  const num = Number(trimmed);
  if (trimmed !== '' && !isNaN(num) && isFinite(num)) {
    return constant(num);
  }

  if (trimmed === 'true') {
    return constant(true);
  }
  if (trimmed === 'false') {
    return constant(false);
  }

  const varExpr = varExprs.get(trimmed);
  if (!varExpr) {
    throw new Error(
      `Unknown operand '${trimmed}'. Declare it in the variables list or use a number/boolean literal.`
    );
  }
  return varExpr;
}
