import type {
  ConstraintVariable,
  Constraint,
  ConstraintExpression,
  ConstraintOperator,
  ConstraintProblem,
  OptimizationType,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

export class Expr {
  constructor(public readonly expression: ConstraintExpression) {}

  static variable(name: string): Expr {
    return new Expr({ type: 'variable', name });
  }

  static constant(value: boolean | number): Expr {
    return new Expr({ type: 'constant', value });
  }

  private binaryOp(other: Expr | number | boolean, operator: ConstraintOperator): Expr {
    const otherExpr =
      other instanceof Expr ? other.expression : { type: 'constant' as const, value: other };

    return new Expr({
      type: 'operation',
      operator,
      operands: [this.expression, otherExpr],
    });
  }

  private unaryOp(operator: ConstraintOperator): Expr {
    return new Expr({
      type: 'operation',
      operator,
      operands: [this.expression],
    });
  }

  add(other: Expr | number): Expr {
    return this.binaryOp(other, 'add');
  }

  sub(other: Expr | number): Expr {
    return this.binaryOp(other, 'sub');
  }

  mul(other: Expr | number): Expr {
    return this.binaryOp(other, 'mul');
  }

  div(other: Expr | number): Expr {
    return this.binaryOp(other, 'div');
  }

  mod(other: Expr | number): Expr {
    return this.binaryOp(other, 'mod');
  }

  pow(other: Expr | number): Expr {
    return this.binaryOp(other, 'pow');
  }

  abs(): Expr {
    return this.unaryOp('abs');
  }

  eq(other: Expr | number | boolean): Expr {
    return this.binaryOp(other, 'eq');
  }

  neq(other: Expr | number | boolean): Expr {
    return this.binaryOp(other, 'neq');
  }

  gt(other: Expr | number): Expr {
    return this.binaryOp(other, 'gt');
  }

  gte(other: Expr | number): Expr {
    return this.binaryOp(other, 'gte');
  }

  lt(other: Expr | number): Expr {
    return this.binaryOp(other, 'lt');
  }

  lte(other: Expr | number): Expr {
    return this.binaryOp(other, 'lte');
  }

  and(other: Expr | boolean): Expr {
    return this.binaryOp(other, 'and');
  }

  or(other: Expr | boolean): Expr {
    return this.binaryOp(other, 'or');
  }

  not(): Expr {
    return this.unaryOp('not');
  }

  implies(other: Expr | boolean): Expr {
    return this.binaryOp(other, 'implies');
  }

  iff(other: Expr | boolean): Expr {
    return this.binaryOp(other, 'iff');
  }

  min(other: Expr | number): Expr {
    return this.binaryOp(other, 'min');
  }

  max(other: Expr | number): Expr {
    return this.binaryOp(other, 'max');
  }
}

export function variable(name: string): Expr {
  return Expr.variable(name);
}

export function constant(value: boolean | number): Expr {
  return Expr.constant(value);
}

export function and(...exprs: (Expr | boolean)[]): Expr {
  if (exprs.length === 0) {
    return constant(true);
  }

  if (exprs.length === 1) {
    return exprs[0] instanceof Expr ? exprs[0] : constant(exprs[0]);
  }

  const operands: ConstraintExpression[] = exprs.map((e) =>
    e instanceof Expr ? e.expression : { type: 'constant' as const, value: e }
  );

  return new Expr({
    type: 'operation',
    operator: 'and',
    operands,
  });
}

export function or(...exprs: (Expr | boolean)[]): Expr {
  if (exprs.length === 0) {
    return constant(false);
  }

  if (exprs.length === 1) {
    return exprs[0] instanceof Expr ? exprs[0] : constant(exprs[0]);
  }

  const operands: ConstraintExpression[] = exprs.map((e) =>
    e instanceof Expr ? e.expression : { type: 'constant' as const, value: e }
  );

  return new Expr({
    type: 'operation',
    operator: 'or',
    operands,
  });
}

export function not(expr: Expr | boolean): Expr {
  if (typeof expr === 'boolean') {
    return constant(!expr);
  }
  return expr.not();
}

export function implies(a: Expr | boolean, b: Expr | boolean): Expr {
  const aExpr = a instanceof Expr ? a : constant(a);
  return aExpr.implies(b);
}

export function iff(a: Expr | boolean, b: Expr | boolean): Expr {
  const aExpr = a instanceof Expr ? a : constant(a);
  return aExpr.iff(b);
}

export function ite(condition: Expr, thenExpr: Expr | number, elseExpr: Expr | number): Expr {
  const thenE =
    thenExpr instanceof Expr ? thenExpr.expression : { type: 'constant' as const, value: thenExpr };
  const elseE =
    elseExpr instanceof Expr ? elseExpr.expression : { type: 'constant' as const, value: elseExpr };

  return new Expr({
    type: 'operation',
    operator: 'ite',
    operands: [condition.expression, thenE, elseE],
  });
}

export function sum(...exprs: (Expr | number)[]): Expr {
  if (exprs.length === 0) {
    return constant(0);
  }

  let result: Expr = exprs[0] instanceof Expr ? exprs[0] : constant(exprs[0]);

  for (let i = 1; i < exprs.length; i++) {
    result = result.add(exprs[i]);
  }

  return result;
}

export function product(...exprs: (Expr | number)[]): Expr {
  if (exprs.length === 0) {
    return constant(1);
  }

  let result: Expr = exprs[0] instanceof Expr ? exprs[0] : constant(exprs[0]);

  for (let i = 1; i < exprs.length; i++) {
    result = result.mul(exprs[i]);
  }

  return result;
}

export function allDifferent(...exprs: Expr[]): Expr {
  const operands: ConstraintExpression[] = exprs.map((e) => e.expression);

  return new Expr({
    type: 'operation',
    operator: 'allDifferent',
    operands,
  });
}

export function atMost(k: number, ...exprs: Expr[]): Expr {
  const operands: ConstraintExpression[] = [
    { type: 'constant' as const, value: k },
    ...exprs.map((e) => e.expression),
  ];

  return new Expr({
    type: 'operation',
    operator: 'atMost',
    operands,
  });
}

export function atLeast(k: number, ...exprs: Expr[]): Expr {
  const operands: ConstraintExpression[] = [
    { type: 'constant' as const, value: k },
    ...exprs.map((e) => e.expression),
  ];

  return new Expr({
    type: 'operation',
    operator: 'atLeast',
    operands,
  });
}

export function exactly(k: number, ...exprs: Expr[]): Expr {
  const operands: ConstraintExpression[] = [
    { type: 'constant' as const, value: k },
    ...exprs.map((e) => e.expression),
  ];

  return new Expr({
    type: 'operation',
    operator: 'exactly',
    operands,
  });
}

export class ConstraintBuilder {
  private variables: ConstraintVariable[] = [];
  private constraints: Constraint[] = [];
  private objective?: {
    type: OptimizationType;
    expression: ConstraintExpression;
  };
  private problemName?: string;

  constructor(name?: string) {
    this.problemName = name;
  }

  static create(name?: string): ConstraintBuilder {
    return new ConstraintBuilder(name);
  }

  bool(name: string): Expr {
    this.variables.push({ name, type: 'bool' });
    return variable(name);
  }

  int(name: string, min?: number, max?: number): Expr {
    this.variables.push({
      name,
      type: 'int',
      domain: min !== undefined || max !== undefined ? { min, max } : undefined,
    });
    return variable(name);
  }

  real(name: string, min?: number, max?: number): Expr {
    this.variables.push({
      name,
      type: 'real',
      domain: min !== undefined || max !== undefined ? { min, max } : undefined,
    });
    return variable(name);
  }

  bitvec(name: string, bitWidth: number): Expr {
    this.variables.push({ name, type: 'bitvec', bitWidth });
    return variable(name);
  }

  boolArray(prefix: string, count: number): Expr[] {
    const vars: Expr[] = [];
    for (let i = 0; i < count; i++) {
      vars.push(this.bool(`${prefix}_${i}`));
    }
    return vars;
  }

  intArray(prefix: string, count: number, min?: number, max?: number): Expr[] {
    const vars: Expr[] = [];
    for (let i = 0; i < count; i++) {
      vars.push(this.int(`${prefix}_${i}`, min, max));
    }
    return vars;
  }

  assert(expr: Expr, name?: string): this {
    this.constraints.push({
      id: nanoid(8),
      name,
      expression: expr.expression,
      isHard: true,
    });
    return this;
  }

  soft(expr: Expr, weight: number = 1, name?: string): this {
    this.constraints.push({
      id: nanoid(8),
      name,
      expression: expr.expression,
      weight,
      isHard: false,
    });
    return this;
  }

  minimize(expr: Expr): this {
    this.objective = {
      type: 'minimize',
      expression: expr.expression,
    };
    return this;
  }

  maximize(expr: Expr): this {
    this.objective = {
      type: 'maximize',
      expression: expr.expression,
    };
    return this;
  }

  build(): ConstraintProblem {
    return {
      id: nanoid(8),
      name: this.problemName,
      variables: [...this.variables],
      constraints: [...this.constraints],
      objective: this.objective,
    };
  }

  clear(): this {
    this.variables = [];
    this.constraints = [];
    this.objective = undefined;
    return this;
  }

  clone(): ConstraintBuilder {
    const builder = new ConstraintBuilder(this.problemName);
    builder.variables = this.variables.map((v) => ({
      ...v,
      domain: v.domain ? { ...v.domain } : undefined,
    }));
    builder.constraints = this.constraints.map((c) => ({ ...c }));
    builder.objective = this.objective ? { ...this.objective } : undefined;
    return builder;
  }
}

export function expressionToString(expr: ConstraintExpression): string {
  switch (expr.type) {
    case 'variable':
      return expr.name;

    case 'constant':
      return String(expr.value);

    case 'operation': {
      const op = expr.operator;
      const operands = expr.operands.map(expressionToString);

      switch (op) {
        case 'not':
          return `¬${operands[0]}`;
        case 'abs':
          return `|${operands[0]}|`;
        case 'and':
          return `(${operands.join(' ∧ ')})`;
        case 'or':
          return `(${operands.join(' ∨ ')})`;
        case 'add':
          return `(${operands.join(' + ')})`;
        case 'sub':
          return `(${operands[0]} - ${operands[1]})`;
        case 'mul':
          return `(${operands.join(' × ')})`;
        case 'div':
          return `(${operands[0]} ÷ ${operands[1]})`;
        case 'mod':
          return `(${operands[0]} mod ${operands[1]})`;
        case 'pow':
          return `(${operands[0]} ^ ${operands[1]})`;
        case 'eq':
          return `(${operands[0]} = ${operands[1]})`;
        case 'neq':
          return `(${operands[0]} ≠ ${operands[1]})`;
        case 'gt':
          return `(${operands[0]} > ${operands[1]})`;
        case 'gte':
          return `(${operands[0]} ≥ ${operands[1]})`;
        case 'lt':
          return `(${operands[0]} < ${operands[1]})`;
        case 'lte':
          return `(${operands[0]} ≤ ${operands[1]})`;
        case 'implies':
          return `(${operands[0]} → ${operands[1]})`;
        case 'iff':
          return `(${operands[0]} ↔ ${operands[1]})`;
        case 'ite':
          return `if ${operands[0]} then ${operands[1]} else ${operands[2]}`;
        case 'allDifferent':
          return `allDifferent(${operands.join(', ')})`;
        case 'atMost':
          return `atMost(${operands[0]}, ${operands.slice(1).join(', ')})`;
        case 'atLeast':
          return `atLeast(${operands[0]}, ${operands.slice(1).join(', ')})`;
        case 'exactly':
          return `exactly(${operands[0]}, ${operands.slice(1).join(', ')})`;
        case 'min':
          return `min(${operands.join(', ')})`;
        case 'max':
          return `max(${operands.join(', ')})`;
        default:
          return `${op}(${operands.join(', ')})`;
      }
    }
  }
}

export function constraintToString(constraint: Constraint): string {
  const expr = expressionToString(constraint.expression);
  const parts: string[] = [];

  if (constraint.name) {
    parts.push(`[${constraint.name}]`);
  }

  parts.push(expr);

  if (!constraint.isHard && constraint.weight !== undefined) {
    parts.push(`(weight: ${constraint.weight})`);
  }

  return parts.join(' ');
}

export function problemToString(problem: ConstraintProblem): string {
  const lines: string[] = [];

  if (problem.name) {
    lines.push(`Problem: ${problem.name}`);
  }

  lines.push('');
  lines.push('Variables:');
  for (const v of problem.variables) {
    let desc = `  ${v.name}: ${v.type}`;
    if (v.domain) {
      desc += ` [${v.domain.min ?? '-∞'}, ${v.domain.max ?? '∞'}]`;
    }
    if (v.bitWidth) {
      desc += ` (${v.bitWidth} bits)`;
    }
    lines.push(desc);
  }

  lines.push('');
  lines.push('Constraints:');
  for (const c of problem.constraints) {
    const prefix = c.isHard ? '  HARD: ' : '  SOFT: ';
    lines.push(prefix + constraintToString(c));
  }

  if (problem.objective) {
    lines.push('');
    lines.push(
      `Objective: ${problem.objective.type} ${expressionToString(problem.objective.expression)}`
    );
  }

  return lines.join('\n');
}
