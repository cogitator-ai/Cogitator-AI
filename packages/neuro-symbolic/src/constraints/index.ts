export {
  Expr,
  ConstraintBuilder,
  variable,
  constant,
  and,
  or,
  not,
  implies,
  iff,
  ite,
  sum,
  product,
  allDifferent,
  atMost,
  atLeast,
  exactly,
  expressionToString,
  constraintToString,
  problemToString,
} from './dsl';

export {
  SimpleSATSolver,
  createSimpleSATSolver,
  solveSAT,
  type SimpleSATConfig,
} from './simple-sat-solver';

export {
  Z3WASMSolver,
  createZ3Solver,
  solveWithZ3,
  isZ3Available,
  type Z3SolverConfig,
} from './z3-wasm-solver';

export {
  createNLToConstraintsPrompt,
  createConstraintExplanationPrompt,
  createUnsatAnalysisPrompt,
  createConstraintSuggestionPrompt,
  parseNLConstraintsResponse,
  formatSolverResultForLLM,
  formatProblemSummary,
  type NLToConstraintsContext,
  type ConstraintExplanationContext,
  type UnsatAnalysisContext,
  type ConstraintSuggestionContext,
  type ParseNLConstraintsResult,
} from './prompts';

import type { ConstraintProblem, SolverResult, ConstraintSolverConfig } from '@cogitator-ai/types';
import { solveSAT, type SimpleSATConfig } from './simple-sat-solver';
import { solveWithZ3, isZ3Available } from './z3-wasm-solver';

let warnedAboutZ3Fallback = false;

export async function solve(
  problem: ConstraintProblem,
  config?: Partial<ConstraintSolverConfig>
): Promise<SolverResult> {
  const solverType = config?.solver ?? 'z3';

  if (solverType === 'z3') {
    if (await isZ3Available()) {
      return solveWithZ3(problem, config);
    }

    if (!warnedAboutZ3Fallback) {
      warnedAboutZ3Fallback = true;
      console.warn('Z3 not available, falling back to simple-sat solver');
    }
  }

  const satConfig: Partial<SimpleSATConfig> = {};
  if (config?.timeout !== undefined) satConfig.timeout = config.timeout;
  if (config?.randomSeed !== undefined) satConfig.randomSeed = config.randomSeed;
  return solveSAT(problem, satConfig);
}
