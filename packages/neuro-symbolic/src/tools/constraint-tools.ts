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
      const varExprs = new Map<string, Expr>();

      for (const v of varDefs) {
        let expr: Expr;
        if (v.type === 'bool') {
          expr = builder.bool(v.name);
        } else if (v.type === 'int') {
          expr = builder.int(v.name, v.min ?? 0, v.max ?? 100);
        } else {
          expr = builder.real(v.name, v.min ?? 0, v.max ?? 100);
        }
        varExprs.set(v.name, expr);
      }

      for (const c of constraintDefs) {
        let leftExpr: Expr;
        let rightExpr: Expr;
        try {
          leftExpr = parseOperand(c.left, varExprs);
          rightExpr = parseOperand(c.right, varExprs);
        } catch (err) {
          return {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          };
        }

        switch (c.op) {
          case 'eq':
            builder.assert(leftExpr.eq(rightExpr));
            break;
          case 'neq':
            builder.assert(leftExpr.neq(rightExpr));
            break;
          case 'gt':
            builder.assert(leftExpr.gt(rightExpr));
            break;
          case 'gte':
            builder.assert(leftExpr.gte(rightExpr));
            break;
          case 'lt':
            builder.assert(leftExpr.lt(rightExpr));
            break;
          case 'lte':
            builder.assert(leftExpr.lte(rightExpr));
            break;
          case 'and':
            builder.assert(leftExpr.and(rightExpr));
            break;
          case 'or':
            builder.assert(leftExpr.or(rightExpr));
            break;
          case 'implies':
            builder.assert(leftExpr.implies(rightExpr));
            break;
        }
      }

      if (objective) {
        const objExpr = varExprs.get(objective.variable);
        if (!objExpr) {
          return {
            content: `Objective variable '${objective.variable}' not found in declared variables`,
            isError: true,
          };
        }
        if (objective.type === 'minimize') {
          builder.minimize(objExpr);
        } else {
          builder.maximize(objExpr);
        }
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
