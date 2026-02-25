import type {
  ConstraintProblem,
  ConstraintVariable,
  ConstraintExpression,
  SolverResult,
  ConstraintModel,
  ConstraintSolverConfig,
} from '@cogitator-ai/types';

export interface Z3SolverConfig extends ConstraintSolverConfig {
  logLevel?: 'off' | 'error' | 'warn' | 'info' | 'debug';
}

const DEFAULT_Z3_CONFIG: Required<Z3SolverConfig> = {
  timeout: 10000,
  solver: 'z3',
  enableOptimization: true,
  randomSeed: 42,
  logLevel: 'off',
};

let z3Module: unknown = null;

async function loadZ3(): Promise<unknown> {
  if (z3Module) return z3Module;

  try {
    const z3 = await import('z3-solver');
    z3Module = z3;
    return z3Module;
  } catch {
    throw new Error('Z3 solver not available. Install z3-solver package: npm install z3-solver');
  }
}

export async function isZ3Available(): Promise<boolean> {
  try {
    await loadZ3();
    return true;
  } catch {
    return false;
  }
}

interface Z3Context {
  Context: new (name: string) => Z3ContextInstance;
}

interface Z3ContextInstance {
  Bool: {
    val: (value: boolean) => Z3Expr;
    const: (name: string) => Z3Expr;
  };
  Int: {
    val: (value: number) => Z3Expr;
    const: (name: string) => Z3Expr;
  };
  Real: {
    val: (value: number) => Z3Expr;
    const: (name: string) => Z3Expr;
  };
  BitVec: {
    val: (value: number, bits: number) => Z3Expr;
    const: (name: string, bits: number) => Z3Expr;
  };
  Solver: new () => Z3Solver;
  Optimize: new () => Z3Optimizer;
  And: (...args: Z3Expr[]) => Z3Expr;
  Or: (...args: Z3Expr[]) => Z3Expr;
  Not: (expr: Z3Expr) => Z3Expr;
  Implies: (a: Z3Expr, b: Z3Expr) => Z3Expr;
  If: (cond: Z3Expr, then: Z3Expr, else_: Z3Expr) => Z3Expr;
  Distinct: (...args: Z3Expr[]) => Z3Expr;
}

interface Z3Expr {
  add: (other: Z3Expr | number) => Z3Expr;
  sub: (other: Z3Expr | number) => Z3Expr;
  mul: (other: Z3Expr | number) => Z3Expr;
  div: (other: Z3Expr | number) => Z3Expr;
  mod: (other: Z3Expr | number) => Z3Expr;
  pow: (other: Z3Expr | number) => Z3Expr;
  eq: (other: Z3Expr | number | boolean) => Z3Expr;
  neq: (other: Z3Expr | number | boolean) => Z3Expr;
  gt: (other: Z3Expr | number) => Z3Expr;
  ge: (other: Z3Expr | number) => Z3Expr;
  lt: (other: Z3Expr | number) => Z3Expr;
  le: (other: Z3Expr | number) => Z3Expr;
  and: (other: Z3Expr) => Z3Expr;
  or: (other: Z3Expr) => Z3Expr;
  not: () => Z3Expr;
  implies: (other: Z3Expr) => Z3Expr;
  toString: () => string;
  value: () => unknown;
}

interface Z3Solver {
  add: (expr: Z3Expr) => void;
  check: () => Promise<'sat' | 'unsat' | 'unknown'>;
  model: () => Z3Model;
  push: () => void;
  pop: () => void;
  setTimeout: (ms: number) => void;
}

interface Z3Optimizer extends Z3Solver {
  minimize: (expr: Z3Expr) => void;
  maximize: (expr: Z3Expr) => void;
  add_soft: (expr: Z3Expr, weight: number) => void;
}

interface Z3Model {
  eval: (expr: Z3Expr, modelCompletion?: boolean) => Z3Expr;
  entries: () => Array<[{ name: () => string }, Z3Expr]>;
}

export class Z3WASMSolver {
  private config: Required<Z3SolverConfig>;
  private ctx: Z3ContextInstance | null = null;
  private variables = new Map<string, Z3Expr>();

  constructor(config: Partial<Z3SolverConfig> = {}) {
    this.config = { ...DEFAULT_Z3_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    const z3 = (await loadZ3()) as { init: () => Promise<Z3Context> };
    const { Context } = await z3.init();
    this.ctx = new Context('cogitator');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.ctx) {
      await this.initialize();
    }
  }

  private createVariable(variable: ConstraintVariable): Z3Expr {
    if (!this.ctx) throw new Error('Z3 not initialized');

    let z3Var: Z3Expr;

    switch (variable.type) {
      case 'bool':
        z3Var = this.ctx.Bool.const(variable.name);
        break;

      case 'int':
        z3Var = this.ctx.Int.const(variable.name);
        break;

      case 'real':
        z3Var = this.ctx.Real.const(variable.name);
        break;

      case 'bitvec':
        z3Var = this.ctx.BitVec.const(variable.name, variable.bitWidth || 32);
        break;

      default:
        throw new Error(`Unknown variable type: ${variable.type}`);
    }

    this.variables.set(variable.name, z3Var);
    return z3Var;
  }

  private translateExpression(expr: ConstraintExpression): Z3Expr {
    if (!this.ctx) throw new Error('Z3 not initialized');

    switch (expr.type) {
      case 'variable': {
        const z3Var = this.variables.get(expr.name);
        if (!z3Var) throw new Error(`Unknown variable: ${expr.name}`);
        return z3Var;
      }

      case 'constant': {
        if (typeof expr.value === 'boolean') {
          return this.ctx.Bool.val(expr.value);
        }
        const numVal = expr.value as number;
        if (Number.isInteger(numVal)) {
          return this.ctx.Int.val(numVal);
        }
        return this.ctx.Real.val(numVal);
      }

      case 'operation': {
        const operands = expr.operands.map((op) => this.translateExpression(op));

        switch (expr.operator) {
          case 'not':
            return this.ctx.Not(operands[0]);

          case 'and':
            return this.ctx.And(...operands);

          case 'or':
            return this.ctx.Or(...operands);

          case 'implies':
            return this.ctx.Implies(operands[0], operands[1]);

          case 'iff':
            return this.ctx.And(
              this.ctx.Implies(operands[0], operands[1]),
              this.ctx.Implies(operands[1], operands[0])
            );

          case 'eq':
            return operands[0].eq(operands[1]);

          case 'neq':
            return operands[0].neq(operands[1]);

          case 'gt':
            return operands[0].gt(operands[1]);

          case 'gte':
            return operands[0].ge(operands[1]);

          case 'lt':
            return operands[0].lt(operands[1]);

          case 'lte':
            return operands[0].le(operands[1]);

          case 'add':
            return operands.reduce((a, b) => a.add(b));

          case 'sub':
            return operands[0].sub(operands[1]);

          case 'mul':
            return operands.reduce((a, b) => a.mul(b));

          case 'div':
            return operands[0].div(operands[1]);

          case 'mod':
            return operands[0].mod(operands[1]);

          case 'pow':
            return operands[0].pow(operands[1]);

          case 'ite':
            return this.ctx.If(operands[0], operands[1], operands[2]);

          case 'abs': {
            const zero = this.ctx.Int.val(0);
            return this.ctx.If(operands[0].ge(zero), operands[0], zero.sub(operands[0]));
          }

          case 'min':
            return this.ctx.If(operands[0].le(operands[1]), operands[0], operands[1]);

          case 'max':
            return this.ctx.If(operands[0].ge(operands[1]), operands[0], operands[1]);

          case 'allDifferent':
            return this.ctx.Distinct(...operands);

          case 'atMost': {
            const k = expr.operands[0];
            if (k.type !== 'constant') throw new Error('atMost requires constant k');
            const boolVars = operands.slice(1);
            const sumExpr = boolVars.reduce((acc, v) => {
              const one = this.ctx!.Int.val(1);
              const zero = this.ctx!.Int.val(0);
              return acc.add(this.ctx!.If(v, one, zero));
            }, this.ctx.Int.val(0));
            return sumExpr.le(k.value as number);
          }

          case 'atLeast': {
            const k = expr.operands[0];
            if (k.type !== 'constant') throw new Error('atLeast requires constant k');
            const boolVars = operands.slice(1);
            const sumExpr = boolVars.reduce((acc, v) => {
              const one = this.ctx!.Int.val(1);
              const zero = this.ctx!.Int.val(0);
              return acc.add(this.ctx!.If(v, one, zero));
            }, this.ctx.Int.val(0));
            return sumExpr.ge(k.value as number);
          }

          case 'exactly': {
            const k = expr.operands[0];
            if (k.type !== 'constant') throw new Error('exactly requires constant k');
            const boolVars = operands.slice(1);
            const sumExpr = boolVars.reduce((acc, v) => {
              const one = this.ctx!.Int.val(1);
              const zero = this.ctx!.Int.val(0);
              return acc.add(this.ctx!.If(v, one, zero));
            }, this.ctx.Int.val(0));
            return sumExpr.eq(k.value as number);
          }

          default:
            throw new Error(`Unsupported operator: ${expr.operator}`);
        }
      }
    }
  }

  private addDomainConstraints(solver: Z3Solver, variables: ConstraintVariable[]): void {
    if (!this.ctx) return;

    for (const variable of variables) {
      const z3Var = this.variables.get(variable.name);
      if (!z3Var || !variable.domain) continue;

      if (variable.domain.min !== undefined) {
        solver.add(z3Var.ge(variable.domain.min));
      }

      if (variable.domain.max !== undefined) {
        solver.add(z3Var.le(variable.domain.max));
      }
    }
  }

  async solve(problem: ConstraintProblem): Promise<SolverResult> {
    try {
      await this.ensureInitialized();

      if (!this.ctx) {
        return { status: 'error', message: 'Failed to initialize Z3' };
      }

      this.variables.clear();

      for (const variable of problem.variables) {
        this.createVariable(variable);
      }

      let solver: Z3Solver;
      let isOptimizing = false;

      if (problem.objective && this.config.enableOptimization) {
        solver = new this.ctx.Optimize();
        isOptimizing = true;
      } else {
        solver = new this.ctx.Solver();
      }

      solver.setTimeout(this.config.timeout);

      this.addDomainConstraints(solver, problem.variables);

      for (const constraint of problem.constraints) {
        const z3Expr = this.translateExpression(constraint.expression);
        if (constraint.isHard) {
          solver.add(z3Expr);
        } else if (isOptimizing) {
          (solver as Z3Optimizer).add_soft(z3Expr, constraint.weight || 1);
        }
      }

      if (isOptimizing && problem.objective) {
        const objExpr = this.translateExpression(problem.objective.expression);
        const optimizer = solver as Z3Optimizer;

        if (problem.objective.type === 'minimize') {
          optimizer.minimize(objExpr);
        } else {
          optimizer.maximize(objExpr);
        }
      }

      const status = await solver.check();

      if (status === 'sat') {
        const model = solver.model();
        const assignments: Record<string, boolean | number> = {};

        for (const [name, z3Var] of this.variables) {
          const value = model.eval(z3Var, true);
          const rawValue = value.value();

          if (typeof rawValue === 'boolean') {
            assignments[name] = rawValue;
          } else if (typeof rawValue === 'number') {
            assignments[name] = rawValue;
          } else if (typeof rawValue === 'bigint') {
            assignments[name] = Number(rawValue);
          } else if (typeof rawValue === 'string') {
            if (rawValue === 'true') {
              assignments[name] = true;
            } else if (rawValue === 'false') {
              assignments[name] = false;
            } else {
              assignments[name] = parseFloat(rawValue);
            }
          }
        }

        const result: ConstraintModel = { assignments };

        if (problem.objective) {
          const objExpr = this.translateExpression(problem.objective.expression);
          const objValue = model.eval(objExpr, true).value();
          if (typeof objValue === 'number') {
            result.objectiveValue = objValue;
          } else if (typeof objValue === 'bigint') {
            result.objectiveValue = Number(objValue);
          }
        }

        return { status: 'sat', model: result };
      }

      if (status === 'unsat') {
        return { status: 'unsat' };
      }

      return { status: 'unknown', reason: 'Solver returned unknown' };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function createZ3Solver(config?: Partial<Z3SolverConfig>): Z3WASMSolver {
  return new Z3WASMSolver(config);
}

export async function solveWithZ3(
  problem: ConstraintProblem,
  config?: Partial<Z3SolverConfig>
): Promise<SolverResult> {
  const solver = createZ3Solver(config);
  return solver.solve(problem);
}
