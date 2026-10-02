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
    return (s >>> 0) / 0x100000000;
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

const MAX_EXHAUSTIVE_ASSIGNMENTS = 1 << 20;
const MAX_EXHAUSTIVE_BITVEC_WIDTH = 20;
const DEFAULT_UNBOUNDED_RANGE = 1000;
const HARD_VIOLATION_COST = 1_000_000;

interface Candidate {
  model: ConstraintModel;
  softScore: number;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let result = value;
  if (min !== undefined && result < min) result = min;
  if (max !== undefined && result > max) result = max;
  return result;
}

function initialValue(variable: ConstraintVariable): boolean | number {
  switch (variable.type) {
    case 'bool':
      return false;
    case 'int': {
      const min = variable.domain?.min;
      const max = variable.domain?.max;
      const value = clamp(0, min, max);
      return Number.isInteger(value) ? value : Math.ceil(value);
    }
    case 'real':
      return clamp(0, variable.domain?.min, variable.domain?.max);
    case 'bitvec':
      return 0;
  }
}

function generateInitialAssignment(variables: ConstraintVariable[]): Assignment {
  const assignment: Assignment = new Map();
  for (const v of variables) assignment.set(v.name, initialValue(v));
  return assignment;
}

function integerBounds(variable: ConstraintVariable): { min: number; max: number } {
  const min = variable.domain?.min;
  const max = variable.domain?.max;
  if (min !== undefined && max !== undefined) return { min: Math.ceil(min), max: Math.floor(max) };
  if (min !== undefined)
    return { min: Math.ceil(min), max: Math.ceil(min) + DEFAULT_UNBOUNDED_RANGE };
  if (max !== undefined)
    return { min: Math.floor(max) - DEFAULT_UNBOUNDED_RANGE, max: Math.floor(max) };
  return { min: -DEFAULT_UNBOUNDED_RANGE, max: DEFAULT_UNBOUNDED_RANGE };
}

function realBounds(variable: ConstraintVariable): { min: number; max: number } {
  return {
    min: variable.domain?.min ?? -DEFAULT_UNBOUNDED_RANGE,
    max: variable.domain?.max ?? DEFAULT_UNBOUNDED_RANGE,
  };
}

function finiteDomain(variable: ConstraintVariable): (boolean | number)[] | null {
  switch (variable.type) {
    case 'bool':
      return [false, true];
    case 'int': {
      if (variable.domain?.min === undefined || variable.domain?.max === undefined) return null;
      const min = Math.ceil(variable.domain.min);
      const max = Math.floor(variable.domain.max);
      if (max < min) return [];
      if (max - min + 1 > MAX_EXHAUSTIVE_ASSIGNMENTS) return null;
      return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }
    case 'bitvec': {
      const width = variable.bitWidth ?? 8;
      if (width > MAX_EXHAUSTIVE_BITVEC_WIDTH) return null;
      const min = Math.max(0, Math.ceil(variable.domain?.min ?? 0));
      const max = Math.min(2 ** width - 1, Math.floor(variable.domain?.max ?? 2 ** width - 1));
      if (max < min) return [];
      return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }
    case 'real':
      return null;
  }
}

function flipVariable(assignment: Assignment, variable: ConstraintVariable): Assignment[] {
  const neighbors: Assignment[] = [];
  const current = assignment.get(variable.name);
  if (current === undefined) return neighbors;

  const withValue = (value: boolean | number): void => {
    const neighbor = new Map(assignment);
    neighbor.set(variable.name, value);
    neighbors.push(neighbor);
  };

  switch (variable.type) {
    case 'bool':
      withValue(!current);
      break;

    case 'int': {
      const { min, max } = integerBounds(variable);
      const val = current as number;
      for (const delta of [-1, 1, -5, 5, -10, 10]) {
        const next = val + delta;
        if (next >= min && next <= max) withValue(next);
      }
      break;
    }

    case 'real': {
      const { min, max } = realBounds(variable);
      const val = current as number;
      for (const delta of [-1, -0.1, 0.1, 1]) {
        const next = val + delta;
        if (next >= min && next <= max) withValue(next);
      }
      break;
    }

    case 'bitvec': {
      const bitWidth = variable.bitWidth || 8;
      const maxVal = 2 ** bitWidth - 1;
      const val = current as number;
      for (let bit = 0; bit < Math.min(bitWidth, 31); bit++) {
        const flipped = val ^ (1 << bit);
        if (flipped >= 0 && flipped <= maxVal) withValue(flipped);
      }
      for (const delta of [-1, 1]) {
        const next = val + delta;
        if (next >= 0 && next <= maxVal) withValue(next);
      }
      break;
    }
  }

  return neighbors;
}

function generateRandomAssignment(variables: ConstraintVariable[], random: RandomFn): Assignment {
  const assignment: Assignment = new Map();

  for (const v of variables) {
    switch (v.type) {
      case 'bool':
        assignment.set(v.name, random() < 0.5);
        break;
      case 'int': {
        const { min, max } = integerBounds(v);
        assignment.set(v.name, Math.floor(random() * (max - min + 1)) + min);
        break;
      }
      case 'real': {
        const { min, max } = realBounds(v);
        assignment.set(v.name, random() * (max - min) + min);
        break;
      }
      case 'bitvec': {
        const maxVal = 2 ** (v.bitWidth || 8) - 1;
        assignment.set(v.name, Math.floor(random() * (maxVal + 1)));
        break;
      }
    }
  }

  return assignment;
}

function objectiveOf(problem: ConstraintProblem, assignment: Assignment): number | undefined {
  if (!problem.objective) return undefined;
  const value = evaluateExpression(problem.objective.expression, assignment);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toCandidate(
  problem: ConstraintProblem,
  assignment: Assignment,
  softScore: number
): Candidate {
  const model: ConstraintModel = { assignments: Object.fromEntries(assignment) };
  const objectiveValue = objectiveOf(problem, assignment);
  if (objectiveValue !== undefined) model.objectiveValue = objectiveValue;
  return { model, softScore };
}

function isBetterCandidate(
  candidate: Candidate,
  best: Candidate | null,
  problem: ConstraintProblem
): boolean {
  if (!best) return true;
  if (candidate.softScore !== best.softScore) return candidate.softScore < best.softScore;
  if (!problem.objective) return false;
  const value = candidate.model.objectiveValue;
  const bestValue = best.model.objectiveValue;
  if (value === undefined) return false;
  if (bestValue === undefined) return true;
  return isBetterObjective(value, bestValue, problem.objective.type);
}

function needsOptimization(problem: ConstraintProblem): boolean {
  return problem.objective !== undefined || problem.constraints.some((c) => !c.isHard);
}

function solveExhaustively(
  problem: ConstraintProblem,
  domains: (boolean | number)[][],
  config: SimpleSATConfig
): SolverResult {
  const startTime = Date.now();
  const optimize = needsOptimization(problem);
  const indices = new Array<number>(domains.length).fill(0);
  let best: Candidate | null = null;

  if (domains.some((d) => d.length === 0)) return { status: 'unsat' };

  for (let iteration = 0; ; iteration++) {
    if ((iteration & 1023) === 0 && Date.now() - startTime > config.timeout) {
      return best ? { status: 'sat', model: best.model } : { status: 'timeout' };
    }

    const assignment: Assignment = new Map();
    problem.variables.forEach((v, i) => assignment.set(v.name, domains[i][indices[i]]));

    const check = checkAllConstraints(problem.constraints, assignment);
    if (check.satisfied) {
      const candidate = toCandidate(problem, assignment, check.softScore);
      if (!optimize) return { status: 'sat', model: candidate.model };
      if (isBetterCandidate(candidate, best, problem)) best = candidate;
    }

    let position = 0;
    while (position < indices.length) {
      indices[position]++;
      if (indices[position] < domains[position].length) break;
      indices[position] = 0;
      position++;
    }
    if (position === indices.length) break;
  }

  return best ? { status: 'sat', model: best.model } : { status: 'unsat' };
}

function cost(constraints: Constraint[], assignment: Assignment): number {
  const check = checkAllConstraints(constraints, assignment);
  return check.violatedHard.length * HARD_VIOLATION_COST + check.softScore;
}

function solveWithLocalSearch(
  problem: ConstraintProblem,
  config: SimpleSATConfig,
  random: RandomFn
): SolverResult {
  const startTime = Date.now();
  const optimize = needsOptimization(problem);
  let assignment = generateInitialAssignment(problem.variables);
  let currentCost = cost(problem.constraints, assignment);
  let best: Candidate | null = null;
  let fewestViolations = Infinity;
  let stagnation = 0;
  let iteration = 0;

  for (; iteration < config.maxIterations; iteration++) {
    if (Date.now() - startTime > config.timeout) {
      return best ? { status: 'sat', model: best.model } : { status: 'timeout' };
    }

    const check = checkAllConstraints(problem.constraints, assignment);
    fewestViolations = Math.min(fewestViolations, check.violatedHard.length);

    if (check.satisfied) {
      const candidate = toCandidate(problem, assignment, check.softScore);
      if (!optimize) return { status: 'sat', model: candidate.model };
      if (isBetterCandidate(candidate, best, problem)) {
        best = candidate;
        stagnation = 0;
      }
    }

    let moved = false;
    for (const variable of problem.variables) {
      for (const neighbor of flipVariable(assignment, variable)) {
        const neighborCost = cost(problem.constraints, neighbor);
        const improvesCost = neighborCost < currentCost;
        const improvesObjective =
          neighborCost === currentCost &&
          check.satisfied &&
          problem.objective !== undefined &&
          isBetterCandidate(
            toCandidate(problem, neighbor, check.softScore),
            toCandidate(problem, assignment, check.softScore),
            problem
          );

        if (improvesCost || improvesObjective) {
          assignment = neighbor;
          currentCost = neighborCost;
          moved = true;
          break;
        }
      }
      if (moved) break;
    }

    if (!moved) stagnation++;

    if (stagnation > 100) {
      assignment = generateRandomAssignment(problem.variables, random);
      currentCost = cost(problem.constraints, assignment);
      stagnation = 0;
    } else if (!moved) {
      const randomVar = problem.variables[Math.floor(random() * problem.variables.length)];
      const neighbors = flipVariable(assignment, randomVar);
      if (neighbors.length > 0) {
        assignment = neighbors[Math.floor(random() * neighbors.length)];
        currentCost = cost(problem.constraints, assignment);
      }
    }
  }

  if (best) return { status: 'sat', model: best.model };

  return {
    status: 'unknown',
    reason: `Could not find satisfying assignment after ${iteration} iterations. Best had ${fewestViolations} violations.`,
  };
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

  const seen = new Set<string>();
  for (const variable of problem.variables) {
    if (seen.has(variable.name)) {
      return { status: 'error', message: `Duplicate variable declaration: ${variable.name}` };
    }
    seen.add(variable.name);
  }

  const domains = problem.variables.map(finiteDomain);
  const finite = domains.every((d): d is (boolean | number)[] => d !== null);
  if (finite) {
    const size = domains.reduce((acc, d) => acc * Math.max(d.length, 1), 1);
    if (size <= MAX_EXHAUSTIVE_ASSIGNMENTS) {
      return solveExhaustively(problem, domains, mergedConfig);
    }
  }

  return solveWithLocalSearch(problem, mergedConfig, random);
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
