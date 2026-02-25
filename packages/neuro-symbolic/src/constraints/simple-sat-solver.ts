import type {
  ConstraintProblem,
  ConstraintVariable,
  Constraint,
  ConstraintExpression,
  SolverResult,
  ConstraintModel,
} from '@cogitator-ai/types';

export interface SimpleSATConfig {
  timeout: number;
  maxIterations: number;
  randomSeed?: number;
}

const DEFAULT_CONFIG: SimpleSATConfig = {
  timeout: 10000,
  maxIterations: 10000,
};

type Assignment = Map<string, boolean | number>;
type RandomFn = () => number;

function createSeededRandom(seed: number): RandomFn {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function isBetterObjective(value: number, best: number, type: 'minimize' | 'maximize'): boolean {
  return type === 'minimize' ? value < best : value > best;
}

function evaluateExpression(
  expr: ConstraintExpression,
  assignment: Assignment
): boolean | number | null {
  switch (expr.type) {
    case 'variable': {
      const value = assignment.get(expr.name);
      if (value === undefined) return null;
      return value;
    }

    case 'constant':
      return expr.value;

    case 'operation': {
      const operands = expr.operands.map((op) => evaluateExpression(op, assignment));

      if (operands.some((op) => op === null)) {
        return null;
      }

      switch (expr.operator) {
        case 'not':
          return operands[0] === true ? false : operands[0] === false ? true : null;

        case 'and':
          return operands.every((op) => op === true);

        case 'or':
          return operands.some((op) => op === true);

        case 'implies':
          return !operands[0] || !!operands[1];

        case 'iff':
          return operands[0] === operands[1];

        case 'eq':
          return operands[0] === operands[1];

        case 'neq':
          return operands[0] !== operands[1];

        case 'gt':
          return (operands[0] as number) > (operands[1] as number);

        case 'gte':
          return (operands[0] as number) >= (operands[1] as number);

        case 'lt':
          return (operands[0] as number) < (operands[1] as number);

        case 'lte':
          return (operands[0] as number) <= (operands[1] as number);

        case 'add':
          return operands.reduce((a, b) => (a as number) + (b as number), 0);

        case 'sub':
          return (operands[0] as number) - (operands[1] as number);

        case 'mul':
          return operands.reduce((a, b) => (a as number) * (b as number), 1);

        case 'div':
          if ((operands[1] as number) === 0) return null;
          return (operands[0] as number) / (operands[1] as number);

        case 'mod':
          if ((operands[1] as number) === 0) return null;
          return (operands[0] as number) % (operands[1] as number);

        case 'pow':
          return Math.pow(operands[0] as number, operands[1] as number);

        case 'abs':
          return Math.abs(operands[0] as number);

        case 'min':
          return Math.min(...(operands as number[]));

        case 'max':
          return Math.max(...(operands as number[]));

        case 'ite':
          return operands[0] === true ? operands[1] : operands[2];

        case 'allDifferent': {
          const seen = new Set<number | boolean>();
          for (const op of operands) {
            if (seen.has(op!)) return false;
            seen.add(op!);
          }
          return true;
        }

        case 'atMost': {
          const k = operands[0] as number;
          const trueCount = operands.slice(1).filter((op) => op === true).length;
          return trueCount <= k;
        }

        case 'atLeast': {
          const k = operands[0] as number;
          const trueCount = operands.slice(1).filter((op) => op === true).length;
          return trueCount >= k;
        }

        case 'exactly': {
          const k = operands[0] as number;
          const trueCount = operands.slice(1).filter((op) => op === true).length;
          return trueCount === k;
        }

        default:
          return null;
      }
    }
  }
}

function checkConstraint(constraint: Constraint, assignment: Assignment): boolean {
  const result = evaluateExpression(constraint.expression, assignment);
  return result === true;
}

function checkAllConstraints(
  constraints: Constraint[],
  assignment: Assignment
): {
  satisfied: boolean;
  violatedHard: string[];
  violatedSoft: string[];
  softScore: number;
} {
  const violatedHard: string[] = [];
  const violatedSoft: string[] = [];
  let softScore = 0;

  for (const constraint of constraints) {
    const satisfied = checkConstraint(constraint, assignment);

    if (!satisfied) {
      if (constraint.isHard) {
        violatedHard.push(constraint.id);
      } else {
        violatedSoft.push(constraint.id);
        softScore += constraint.weight || 1;
      }
    }
  }

  return {
    satisfied: violatedHard.length === 0,
    violatedHard,
    violatedSoft,
    softScore,
  };
}

function generateInitialAssignment(variables: ConstraintVariable[]): Assignment {
  const assignment = new Map<string, boolean | number>();

  for (const v of variables) {
    switch (v.type) {
      case 'bool':
        assignment.set(v.name, false);
        break;

      case 'int':
        if (v.domain) {
          const min = v.domain.min ?? 0;
          assignment.set(v.name, min);
        } else {
          assignment.set(v.name, 0);
        }
        break;

      case 'real':
        if (v.domain) {
          const min = v.domain.min ?? 0;
          assignment.set(v.name, min);
        } else {
          assignment.set(v.name, 0);
        }
        break;

      case 'bitvec':
        assignment.set(v.name, 0);
        break;
    }
  }

  return assignment;
}

function flipVariable(
  assignment: Assignment,
  variable: ConstraintVariable
): Map<string, boolean | number>[] {
  const neighbors: Map<string, boolean | number>[] = [];

  const current = assignment.get(variable.name);
  if (current === undefined) return neighbors;

  switch (variable.type) {
    case 'bool': {
      const neighbor = new Map(assignment);
      neighbor.set(variable.name, !current);
      neighbors.push(neighbor);
      break;
    }

    case 'int': {
      const min = variable.domain?.min ?? -1000;
      const max = variable.domain?.max ?? 1000;
      const val = current as number;

      if (val > min) {
        const neighbor = new Map(assignment);
        neighbor.set(variable.name, val - 1);
        neighbors.push(neighbor);
      }
      if (val < max) {
        const neighbor = new Map(assignment);
        neighbor.set(variable.name, val + 1);
        neighbors.push(neighbor);
      }

      for (const delta of [-10, -5, 5, 10]) {
        const newVal = val + delta;
        if (newVal >= min && newVal <= max) {
          const neighbor = new Map(assignment);
          neighbor.set(variable.name, newVal);
          neighbors.push(neighbor);
        }
      }
      break;
    }

    case 'real': {
      const min = variable.domain?.min ?? -1000;
      const max = variable.domain?.max ?? 1000;
      const val = current as number;

      for (const delta of [-1, -0.1, 0.1, 1]) {
        const newVal = val + delta;
        if (newVal >= min && newVal <= max) {
          const neighbor = new Map(assignment);
          neighbor.set(variable.name, newVal);
          neighbors.push(neighbor);
        }
      }
      break;
    }
  }

  return neighbors;
}

function countViolations(constraints: Constraint[], assignment: Assignment): number {
  let count = 0;
  for (const constraint of constraints) {
    if (constraint.isHard && !checkConstraint(constraint, assignment)) {
      count++;
    }
  }
  return count;
}

function solveWithLocalSearch(
  problem: ConstraintProblem,
  config: SimpleSATConfig,
  random: RandomFn
): SolverResult {
  const startTime = Date.now();
  let assignment = generateInitialAssignment(problem.variables);
  let bestAssignment = assignment;
  let bestViolations = countViolations(problem.constraints, assignment);

  let bestSatModel: ConstraintModel | null = null;

  let iteration = 0;
  let noImprovementCount = 0;

  while (iteration < config.maxIterations) {
    if (Date.now() - startTime > config.timeout) {
      if (bestSatModel) {
        return { status: 'sat', model: bestSatModel };
      }
      return { status: 'timeout' };
    }

    const check = checkAllConstraints(problem.constraints, assignment);

    if (check.satisfied) {
      const model: ConstraintModel = {
        assignments: Object.fromEntries(assignment),
      };

      if (problem.objective) {
        const objValue = evaluateExpression(problem.objective.expression, assignment);
        if (typeof objValue === 'number') {
          model.objectiveValue = objValue;
          if (
            !bestSatModel ||
            isBetterObjective(objValue, bestSatModel.objectiveValue!, problem.objective.type)
          ) {
            bestSatModel = model;
          }
        }
      } else {
        return { status: 'sat', model };
      }
    }

    const violations = check.violatedHard.length;
    if (violations < bestViolations) {
      bestViolations = violations;
      bestAssignment = new Map(assignment);
      noImprovementCount = 0;
    } else {
      noImprovementCount++;
    }

    if (noImprovementCount > 100) {
      assignment = generateRandomAssignment(problem.variables, random);
      noImprovementCount = 0;
    }

    let improved = false;

    for (const variable of problem.variables) {
      const neighbors = flipVariable(assignment, variable);

      for (const neighbor of neighbors) {
        const neighborViolations = countViolations(problem.constraints, neighbor);

        if (neighborViolations < violations) {
          assignment = neighbor;
          improved = true;
          break;
        }
      }

      if (improved) break;
    }

    if (!improved) {
      const randomVar = problem.variables[Math.floor(random() * problem.variables.length)];
      const neighbors = flipVariable(assignment, randomVar);
      if (neighbors.length > 0) {
        assignment = neighbors[Math.floor(random() * neighbors.length)];
      }
    }

    iteration++;
  }

  if (bestSatModel) {
    return { status: 'sat', model: bestSatModel };
  }

  const finalCheck = checkAllConstraints(problem.constraints, bestAssignment);

  if (finalCheck.satisfied) {
    const model: ConstraintModel = {
      assignments: Object.fromEntries(bestAssignment),
    };
    return { status: 'sat', model };
  }

  return {
    status: 'unknown',
    reason: `Could not find satisfying assignment after ${iteration} iterations. Best had ${bestViolations} violations.`,
  };
}

function generateRandomAssignment(
  variables: ConstraintVariable[],
  random: RandomFn = Math.random
): Assignment {
  const assignment = new Map<string, boolean | number>();

  for (const v of variables) {
    switch (v.type) {
      case 'bool':
        assignment.set(v.name, random() < 0.5);
        break;

      case 'int': {
        const min = v.domain?.min ?? -100;
        const max = v.domain?.max ?? 100;
        assignment.set(v.name, Math.floor(random() * (max - min + 1)) + min);
        break;
      }

      case 'real': {
        const min = v.domain?.min ?? -100;
        const max = v.domain?.max ?? 100;
        assignment.set(v.name, random() * (max - min) + min);
        break;
      }

      case 'bitvec': {
        const maxVal = Math.pow(2, v.bitWidth || 8) - 1;
        assignment.set(v.name, Math.floor(random() * (maxVal + 1)));
        break;
      }
    }
  }

  return assignment;
}

export function solveSAT(
  problem: ConstraintProblem,
  config: Partial<SimpleSATConfig> = {}
): SolverResult {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const random: RandomFn =
    mergedConfig.randomSeed !== undefined
      ? createSeededRandom(mergedConfig.randomSeed)
      : Math.random;

  if (problem.variables.length === 0) {
    return {
      status: 'sat',
      model: { assignments: {} },
    };
  }

  if (problem.constraints.length === 0) {
    const assignment = generateInitialAssignment(problem.variables);
    const model: ConstraintModel = {
      assignments: Object.fromEntries(assignment),
    };
    return { status: 'sat', model };
  }

  const isBooleanOnly = problem.variables.every((v) => v.type === 'bool');

  if (isBooleanOnly && problem.variables.length <= 20) {
    return solveWithBruteForce(problem, mergedConfig, random);
  }

  return solveWithLocalSearch(problem, mergedConfig, random);
}

function solveWithBruteForce(
  problem: ConstraintProblem,
  config: SimpleSATConfig,
  _random: RandomFn
): SolverResult {
  const startTime = Date.now();
  const n = problem.variables.length;
  const total = Math.pow(2, n);

  let bestModel: ConstraintModel | null = null;

  for (let i = 0; i < total; i++) {
    if (Date.now() - startTime > config.timeout) {
      if (bestModel) return { status: 'sat', model: bestModel };
      return { status: 'timeout' };
    }

    const assignment = new Map<string, boolean | number>();

    for (let j = 0; j < n; j++) {
      assignment.set(problem.variables[j].name, ((i >> j) & 1) === 1);
    }

    const check = checkAllConstraints(problem.constraints, assignment);

    if (check.satisfied) {
      const model: ConstraintModel = {
        assignments: Object.fromEntries(assignment),
      };

      if (problem.objective) {
        const objValue = evaluateExpression(problem.objective.expression, assignment);
        if (typeof objValue === 'number') {
          model.objectiveValue = objValue;
          if (
            !bestModel ||
            isBetterObjective(objValue, bestModel.objectiveValue!, problem.objective.type)
          ) {
            bestModel = model;
          }
        }
      } else {
        return { status: 'sat', model };
      }
    }
  }

  if (bestModel) return { status: 'sat', model: bestModel };
  return { status: 'unsat' };
}

export class SimpleSATSolver {
  private config: SimpleSATConfig;

  constructor(config: Partial<SimpleSATConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  solve(problem: ConstraintProblem): SolverResult {
    return solveSAT(problem, this.config);
  }

  check(problem: ConstraintProblem, assignment: Record<string, boolean | number>): boolean {
    const assignmentMap = new Map(Object.entries(assignment));
    const result = checkAllConstraints(problem.constraints, assignmentMap);
    return result.satisfied;
  }

  evaluate(
    problem: ConstraintProblem,
    assignment: Record<string, boolean | number>
  ): {
    satisfied: boolean;
    violatedHard: string[];
    violatedSoft: string[];
    softScore: number;
  } {
    const assignmentMap = new Map(Object.entries(assignment));
    return checkAllConstraints(problem.constraints, assignmentMap);
  }
}

export function createSimpleSATSolver(config?: Partial<SimpleSATConfig>): SimpleSATSolver {
  return new SimpleSATSolver(config);
}
