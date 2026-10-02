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

interface Z3Expr {
  sexpr(): string;
}

interface Z3Bool extends Z3Expr {
  eq(other: Z3Bool): Z3Bool;
  neq(other: Z3Bool): Z3Bool;
}

interface Z3Arith extends Z3Expr {
  add(other: Z3Arith): Z3Arith;
  sub(other: Z3Arith): Z3Arith;
  mul(other: Z3Arith): Z3Arith;
  div(other: Z3Arith): Z3Arith;
  mod(other: Z3Arith): Z3Arith;
  pow(other: Z3Arith): Z3Arith;
  neg(): Z3Arith;
  eq(other: Z3Arith): Z3Bool;
  neq(other: Z3Arith): Z3Bool;
  gt(other: Z3Arith): Z3Bool;
  ge(other: Z3Arith): Z3Bool;
  lt(other: Z3Arith): Z3Bool;
  le(other: Z3Arith): Z3Bool;
}

interface Z3BitVec extends Z3Expr {
  add(other: Z3BitVec): Z3BitVec;
  sub(other: Z3BitVec): Z3BitVec;
  mul(other: Z3BitVec): Z3BitVec;
  udiv(other: Z3BitVec): Z3BitVec;
  urem(other: Z3BitVec): Z3BitVec;
  eq(other: Z3BitVec): Z3Bool;
  neq(other: Z3BitVec): Z3Bool;
  ugt(other: Z3BitVec): Z3Bool;
  uge(other: Z3BitVec): Z3Bool;
  ult(other: Z3BitVec): Z3Bool;
  ule(other: Z3BitVec): Z3Bool;
}

interface Z3IntNum extends Z3Arith {
  value(): bigint;
}

interface Z3RatNum extends Z3Arith {
  asNumber(): number;
}

interface Z3BitVecNum extends Z3BitVec {
  value(): bigint;
}

interface Z3Model {
  eval(expr: Z3Expr, modelCompletion?: boolean): Z3Expr;
}

interface Z3Solver {
  set(key: string, value: unknown): void;
  add(...exprs: Z3Bool[]): void;
  check(): Promise<'sat' | 'unsat' | 'unknown'>;
  model(): Z3Model;
  reasonUnknown?(): string;
}

interface Z3Optimize extends Z3Solver {
  addSoft(expr: Z3Bool, weight: number): void;
  minimize(expr: Z3Arith): void;
  maximize(expr: Z3Arith): void;
}

interface Z3Context {
  Bool: { val(value: boolean): Z3Bool; const(name: string): Z3Bool };
  Int: { val(value: number | bigint): Z3Arith; const(name: string): Z3Arith };
  Real: { val(value: number): Z3Arith; const(name: string): Z3Arith };
  BitVec: {
    val(value: number | bigint, bits: number): Z3BitVec;
    const(name: string, bits: number): Z3BitVec;
  };
  Solver: new () => Z3Solver;
  Optimize: new () => Z3Optimize;
  And(...args: Z3Bool[]): Z3Bool;
  Or(...args: Z3Bool[]): Z3Bool;
  Not(arg: Z3Bool): Z3Bool;
  Implies(a: Z3Bool, b: Z3Bool): Z3Bool;
  If<T extends Z3Expr>(condition: Z3Bool, onTrue: T, onFalse: T): T;
  Distinct(...args: Z3Expr[]): Z3Bool;
  ToReal(expr: Z3Arith): Z3Arith;
  isTrue(expr: Z3Expr): boolean;
  isFalse(expr: Z3Expr): boolean;
  isIntVal(expr: Z3Expr): expr is Z3IntNum;
  isRealVal(expr: Z3Expr): expr is Z3RatNum;
  isBitVecVal(expr: Z3Expr): expr is Z3BitVecNum;
}

interface Z3Module {
  init(): Promise<{ Context: new (name: string) => Z3Context }>;
}

let z3ModulePromise: Promise<Z3Module> | null = null;
let z3ContextPromise: Promise<Z3Context> | null = null;

function loadZ3(): Promise<Z3Module> {
  z3ModulePromise ??= import('z3-solver')
    .then((module) => module as unknown as Z3Module)
    .catch((error: unknown) => {
      z3ModulePromise = null;
      throw new Error(
        `Z3 solver not available (${error instanceof Error ? error.message : String(error)}). ` +
          'Install it with: npm install z3-solver'
      );
    });
  return z3ModulePromise;
}

function getZ3Context(): Promise<Z3Context> {
  z3ContextPromise ??= loadZ3()
    .then(async (z3) => {
      const { Context } = await z3.init();
      return new Context('cogitator');
    })
    .catch((error: unknown) => {
      z3ContextPromise = null;
      throw error;
    });
  return z3ContextPromise;
}

export async function isZ3Available(): Promise<boolean> {
  try {
    await loadZ3();
    return true;
  } catch {
    return false;
  }
}

type Translated =
  | { kind: 'bool'; expr: Z3Bool }
  | { kind: 'int'; expr: Z3Arith }
  | { kind: 'real'; expr: Z3Arith }
  | { kind: 'bitvec'; expr: Z3BitVec; bits: number }
  | { kind: 'literal'; value: number };

type NumericKind = 'int' | 'real' | { bits: number };

type CoercedNumbers =
  | { kind: 'arith'; real: boolean; exprs: Z3Arith[] }
  | { kind: 'bitvec'; bits: number; exprs: Z3BitVec[] };

class UnsupportedModelValueError extends Error {}

class Z3Translator {
  constructor(
    private readonly ctx: Z3Context,
    private readonly variables: Map<string, Translated>
  ) {}

  translate(expr: ConstraintExpression): Translated {
    switch (expr.type) {
      case 'variable': {
        const variable = this.variables.get(expr.name);
        if (!variable) throw new Error(`Unknown variable: ${expr.name}`);
        return variable;
      }
      case 'constant':
        return typeof expr.value === 'boolean'
          ? { kind: 'bool', expr: this.ctx.Bool.val(expr.value) }
          : { kind: 'literal', value: expr.value };
      case 'operation':
        return this.translateOperation(expr.operator, expr.operands);
    }
  }

  toBool(value: Translated, context: string): Z3Bool {
    if (value.kind !== 'bool') throw new Error(`${context} expects a boolean operand`);
    return value.expr;
  }

  toArith(value: Translated, context: string): Z3Arith {
    const coerced = this.coerce([value], context);
    if (coerced.kind !== 'arith') throw new Error(`${context} expects an arithmetic operand`);
    return coerced.exprs[0];
  }

  private targetKind(values: Translated[], context: string): NumericKind {
    let target: NumericKind = 'int';
    for (const value of values) {
      switch (value.kind) {
        case 'bool':
          throw new Error(`${context} expects numeric operands`);
        case 'bitvec':
          if (typeof target === 'object' && target.bits !== value.bits) {
            throw new Error(`${context} mixes bit-vectors of different widths`);
          }
          target = { bits: value.bits };
          break;
        case 'real':
          if (typeof target === 'object') {
            throw new Error(`${context} cannot mix bit-vectors and real numbers`);
          }
          target = 'real';
          break;
        case 'literal':
          if (!Number.isInteger(value.value) && target === 'int') target = 'real';
          break;
        case 'int':
          if (typeof target === 'object') {
            throw new Error(`${context} cannot mix bit-vectors and integer variables`);
          }
          break;
      }
    }
    return target;
  }

  coerce(values: Translated[], context: string): CoercedNumbers {
    const target = this.targetKind(values, context);

    if (typeof target === 'object') {
      const exprs = values.map((value) => {
        if (value.kind === 'bitvec') return value.expr;
        if (value.kind === 'literal' && Number.isInteger(value.value) && value.value >= 0) {
          return this.ctx.BitVec.val(BigInt(value.value), target.bits);
        }
        throw new Error(`${context} expects non-negative integer literals for bit-vectors`);
      });
      return { kind: 'bitvec', bits: target.bits, exprs };
    }

    const real = target === 'real';
    const exprs = values.map((value): Z3Arith => {
      switch (value.kind) {
        case 'literal':
          return real ? this.ctx.Real.val(value.value) : this.ctx.Int.val(BigInt(value.value));
        case 'int':
          return real ? this.ctx.ToReal(value.expr) : value.expr;
        case 'real':
          return value.expr;
        default:
          throw new Error(`${context} expects numeric operands`);
      }
    });
    return { kind: 'arith', real, exprs };
  }

  private numeric(coerced: CoercedNumbers, exprs: Z3Arith[] | Z3BitVec[]): Translated {
    if (coerced.kind === 'bitvec') {
      return { kind: 'bitvec', bits: coerced.bits, expr: exprs[0] as Z3BitVec };
    }
    return { kind: coerced.real ? 'real' : 'int', expr: exprs[0] as Z3Arith };
  }

  private fold(
    operands: Translated[],
    context: string,
    arith: (a: Z3Arith, b: Z3Arith) => Z3Arith,
    bitvec: (a: Z3BitVec, b: Z3BitVec) => Z3BitVec
  ): Translated {
    if (operands.length === 0) throw new Error(`${context} requires operands`);
    const coerced = this.coerce(operands, context);
    if (coerced.kind === 'bitvec') {
      return {
        kind: 'bitvec',
        bits: coerced.bits,
        expr: coerced.exprs.reduce((a, b) => bitvec(a, b)),
      };
    }
    return this.numeric(coerced, [coerced.exprs.reduce((a, b) => arith(a, b))]);
  }

  private compare(
    operands: Translated[],
    context: string,
    arith: (a: Z3Arith, b: Z3Arith) => Z3Bool,
    bitvec: (a: Z3BitVec, b: Z3BitVec) => Z3Bool
  ): Translated {
    this.requireArity(operands, 2, context);
    const coerced = this.coerce(operands, context);
    const expr =
      coerced.kind === 'bitvec'
        ? bitvec(coerced.exprs[0], coerced.exprs[1])
        : arith(coerced.exprs[0], coerced.exprs[1]);
    return { kind: 'bool', expr };
  }

  private requireArity(operands: Translated[], arity: number, context: string): void {
    if (operands.length !== arity) {
      throw new Error(`${context} expects ${arity} operand(s), got ${operands.length}`);
    }
  }

  private equality(operands: Translated[], negate: boolean): Translated {
    const context = negate ? 'neq' : 'eq';
    this.requireArity(operands, 2, context);
    const [a, b] = operands;

    if (a.kind === 'bool' || b.kind === 'bool') {
      const left = this.toBool(a, context);
      const right = this.toBool(b, context);
      return { kind: 'bool', expr: negate ? left.neq(right) : left.eq(right) };
    }

    return this.compare(
      operands,
      context,
      (x, y) => (negate ? x.neq(y) : x.eq(y)),
      (x, y) => (negate ? x.neq(y) : x.eq(y))
    );
  }

  private cardinality(
    operator: 'atMost' | 'atLeast' | 'exactly',
    operands: ConstraintExpression[]
  ): Translated {
    const [k, ...items] = operands;
    if (k?.type !== 'constant' || typeof k.value !== 'number' || !Number.isInteger(k.value)) {
      throw new Error(`${operator} requires a constant integer bound`);
    }

    const one = this.ctx.Int.val(1n);
    const zero = this.ctx.Int.val(0n);
    const count = items
      .map((item) => this.ctx.If(this.toBool(this.translate(item), operator), one, zero))
      .reduce((acc, term) => acc.add(term), this.ctx.Int.val(0n));
    const bound = this.ctx.Int.val(BigInt(k.value));

    const expr =
      operator === 'atMost'
        ? count.le(bound)
        : operator === 'atLeast'
          ? count.ge(bound)
          : count.eq(bound);
    return { kind: 'bool', expr };
  }

  private extremum(operands: Translated[], operator: 'min' | 'max'): Translated {
    if (operands.length === 0) throw new Error(`${operator} requires operands`);
    const coerced = this.coerce(operands, operator);

    if (coerced.kind === 'bitvec') {
      const expr = coerced.exprs.reduce((a, b) =>
        this.ctx.If(operator === 'min' ? a.ule(b) : a.uge(b), a, b)
      );
      return { kind: 'bitvec', bits: coerced.bits, expr };
    }

    const expr = coerced.exprs.reduce((a, b) =>
      this.ctx.If(operator === 'min' ? a.le(b) : a.ge(b), a, b)
    );
    return this.numeric(coerced, [expr]);
  }

  private translateOperation(operator: string, rawOperands: ConstraintExpression[]): Translated {
    if (operator === 'atMost' || operator === 'atLeast' || operator === 'exactly') {
      return this.cardinality(operator, rawOperands);
    }

    const operands = rawOperands.map((operand) => this.translate(operand));
    const bools = (context: string) => operands.map((o) => this.toBool(o, context));

    switch (operator) {
      case 'not':
        this.requireArity(operands, 1, 'not');
        return { kind: 'bool', expr: this.ctx.Not(bools('not')[0]) };
      case 'and':
        return { kind: 'bool', expr: this.ctx.And(...bools('and')) };
      case 'or':
        return { kind: 'bool', expr: this.ctx.Or(...bools('or')) };
      case 'implies': {
        this.requireArity(operands, 2, 'implies');
        const [a, b] = bools('implies');
        return { kind: 'bool', expr: this.ctx.Implies(a, b) };
      }
      case 'iff': {
        this.requireArity(operands, 2, 'iff');
        const [a, b] = bools('iff');
        return { kind: 'bool', expr: a.eq(b) };
      }
      case 'eq':
        return this.equality(operands, false);
      case 'neq':
        return this.equality(operands, true);
      case 'gt':
        return this.compare(
          operands,
          'gt',
          (a, b) => a.gt(b),
          (a, b) => a.ugt(b)
        );
      case 'gte':
        return this.compare(
          operands,
          'gte',
          (a, b) => a.ge(b),
          (a, b) => a.uge(b)
        );
      case 'lt':
        return this.compare(
          operands,
          'lt',
          (a, b) => a.lt(b),
          (a, b) => a.ult(b)
        );
      case 'lte':
        return this.compare(
          operands,
          'lte',
          (a, b) => a.le(b),
          (a, b) => a.ule(b)
        );
      case 'add':
        return this.fold(
          operands,
          'add',
          (a, b) => a.add(b),
          (a, b) => a.add(b)
        );
      case 'mul':
        return this.fold(
          operands,
          'mul',
          (a, b) => a.mul(b),
          (a, b) => a.mul(b)
        );
      case 'sub':
        this.requireArity(operands, 2, 'sub');
        return this.fold(
          operands,
          'sub',
          (a, b) => a.sub(b),
          (a, b) => a.sub(b)
        );
      case 'div':
        this.requireArity(operands, 2, 'div');
        return this.fold(
          operands,
          'div',
          (a, b) => a.div(b),
          (a, b) => a.udiv(b)
        );
      case 'mod': {
        this.requireArity(operands, 2, 'mod');
        const coerced = this.coerce(operands, 'mod');
        if (coerced.kind === 'arith' && coerced.real) {
          throw new Error('mod requires integer operands');
        }
        return this.fold(
          operands,
          'mod',
          (a, b) => a.mod(b),
          (a, b) => a.urem(b)
        );
      }
      case 'pow': {
        this.requireArity(operands, 2, 'pow');
        const coerced = this.coerce(operands, 'pow');
        if (coerced.kind === 'bitvec') throw new Error('pow is not supported for bit-vectors');
        return this.numeric(coerced, [coerced.exprs[0].pow(coerced.exprs[1])]);
      }
      case 'abs': {
        this.requireArity(operands, 1, 'abs');
        const coerced = this.coerce(operands, 'abs');
        if (coerced.kind === 'bitvec') return operands[0];
        const [x] = coerced.exprs;
        const zero = coerced.real ? this.ctx.Real.val(0) : this.ctx.Int.val(0n);
        return this.numeric(coerced, [this.ctx.If(x.ge(zero), x, x.neg())]);
      }
      case 'min':
      case 'max':
        return this.extremum(operands, operator);
      case 'ite': {
        this.requireArity(operands, 3, 'ite');
        const condition = this.toBool(operands[0], 'ite');
        const branches = operands.slice(1);
        if (branches.some((b) => b.kind === 'bool')) {
          const [onTrue, onFalse] = branches.map((b) => this.toBool(b, 'ite'));
          return { kind: 'bool', expr: this.ctx.If(condition, onTrue, onFalse) };
        }
        const coerced = this.coerce(branches, 'ite');
        if (coerced.kind === 'bitvec') {
          return {
            kind: 'bitvec',
            bits: coerced.bits,
            expr: this.ctx.If(condition, coerced.exprs[0], coerced.exprs[1]),
          };
        }
        return this.numeric(coerced, [this.ctx.If(condition, coerced.exprs[0], coerced.exprs[1])]);
      }
      case 'allDifferent': {
        if (operands.length < 2) return { kind: 'bool', expr: this.ctx.Bool.val(true) };
        if (operands.every((o) => o.kind === 'bool')) {
          return { kind: 'bool', expr: this.ctx.Distinct(...bools('allDifferent')) };
        }
        const coerced = this.coerce(operands, 'allDifferent');
        return { kind: 'bool', expr: this.ctx.Distinct(...coerced.exprs) };
      }
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }
}

function declareVariable(ctx: Z3Context, variable: ConstraintVariable): Translated {
  switch (variable.type) {
    case 'bool':
      return { kind: 'bool', expr: ctx.Bool.const(variable.name) };
    case 'int':
      return { kind: 'int', expr: ctx.Int.const(variable.name) };
    case 'real':
      return { kind: 'real', expr: ctx.Real.const(variable.name) };
    case 'bitvec': {
      const bits = variable.bitWidth ?? 32;
      return { kind: 'bitvec', bits, expr: ctx.BitVec.const(variable.name, bits) };
    }
    default:
      throw new Error(`Unknown variable type: ${String(variable.type)}`);
  }
}

function domainConstraints(
  translator: Z3Translator,
  variable: ConstraintVariable,
  declared: Translated
): Z3Bool[] {
  if (!variable.domain || declared.kind === 'bool') return [];

  const bounds: Z3Bool[] = [];
  const { min, max } = variable.domain;

  const bound = (value: number, kind: 'min' | 'max'): Z3Bool => {
    const coerced = translator.coerce([declared, { kind: 'literal', value }], `domain ${kind}`);
    if (coerced.kind === 'bitvec') {
      const [v, b] = coerced.exprs;
      return kind === 'min' ? v.uge(b) : v.ule(b);
    }
    const [v, b] = coerced.exprs;
    return kind === 'min' ? v.ge(b) : v.le(b);
  };

  if (min !== undefined) bounds.push(bound(min, 'min'));
  if (max !== undefined) bounds.push(bound(max, 'max'));
  return bounds;
}

function toModelNumber(ctx: Z3Context, name: string, value: Z3Expr): number {
  if (ctx.isIntVal(value) || ctx.isBitVecVal(value)) {
    const raw = value.value();
    const number = Number(raw);
    if (!Number.isSafeInteger(number)) {
      throw new UnsupportedModelValueError(`Value of ${name} (${raw}) exceeds safe integer range`);
    }
    return number;
  }
  if (ctx.isRealVal(value)) return value.asNumber();
  throw new UnsupportedModelValueError(
    `Value of ${name} is not representable as a JavaScript number: ${value.sexpr()}`
  );
}

function isTimeoutReason(reason: string | undefined): boolean {
  return reason !== undefined && /timeout|canceled|cancelled|resource/i.test(reason);
}

export class Z3WASMSolver {
  private config: Required<Z3SolverConfig>;
  private ctx: Z3Context | null = null;

  constructor(config: Partial<Z3SolverConfig> = {}) {
    this.config = { ...DEFAULT_Z3_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    this.ctx = await getZ3Context();
  }

  async solve(problem: ConstraintProblem): Promise<SolverResult> {
    const startTime = Date.now();

    try {
      if (!this.ctx) await this.initialize();
      const ctx = this.ctx!;

      const variables = new Map<string, Translated>();
      for (const variable of problem.variables) {
        if (variables.has(variable.name)) {
          throw new Error(`Duplicate variable declaration: ${variable.name}`);
        }
        variables.set(variable.name, declareVariable(ctx, variable));
      }

      const translator = new Z3Translator(ctx, variables);
      const softConstraints = problem.constraints.filter((c) => !c.isHard);
      const optimizeObjective = Boolean(problem.objective && this.config.enableOptimization);
      const useOptimizer = optimizeObjective || softConstraints.length > 0;

      const solver: Z3Solver = useOptimizer ? new ctx.Optimize() : new ctx.Solver();
      solver.set('timeout', this.config.timeout);
      solver.set('random_seed', this.config.randomSeed);

      for (const variable of problem.variables) {
        const bounds = domainConstraints(translator, variable, variables.get(variable.name)!);
        if (bounds.length > 0) solver.add(...bounds);
      }

      for (const constraint of problem.constraints) {
        const expr = translator.toBool(
          translator.translate(constraint.expression),
          `constraint ${constraint.name ?? constraint.id}`
        );
        if (constraint.isHard) {
          solver.add(expr);
        } else {
          (solver as Z3Optimize).addSoft(expr, constraint.weight ?? 1);
        }
      }

      const objective = problem.objective
        ? translator.toArith(translator.translate(problem.objective.expression), 'objective')
        : undefined;

      if (optimizeObjective && objective && problem.objective) {
        const optimizer = solver as Z3Optimize;
        if (problem.objective.type === 'minimize') {
          optimizer.minimize(objective);
        } else {
          optimizer.maximize(objective);
        }
      }

      const status = await solver.check();

      if (status === 'unsat') return { status: 'unsat' };

      if (status === 'unknown') {
        const reason = solver.reasonUnknown?.();
        if (isTimeoutReason(reason) || Date.now() - startTime >= this.config.timeout) {
          return { status: 'timeout' };
        }
        return { status: 'unknown', reason: reason || 'Solver returned unknown' };
      }

      const model = solver.model();
      const assignments: Record<string, boolean | number> = {};

      for (const [name, declared] of variables) {
        if (declared.kind === 'literal') continue;
        const value = model.eval(declared.expr, true);
        if (declared.kind === 'bool') {
          assignments[name] = ctx.isTrue(value);
        } else {
          assignments[name] = toModelNumber(ctx, name, value);
        }
      }

      const result: ConstraintModel = { assignments };
      if (objective) {
        result.objectiveValue = toModelNumber(ctx, 'objective', model.eval(objective, true));
      }

      return { status: 'sat', model: result };
    } catch (error) {
      if (error instanceof UnsupportedModelValueError) {
        return { status: 'unknown', reason: error.message };
      }
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
