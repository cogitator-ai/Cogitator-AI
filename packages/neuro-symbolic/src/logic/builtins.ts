import type { Term, CompoundTerm, Substitution, ListTerm } from '@cogitator-ai/types';
import {
  unify,
  applySubstitution,
  termsEqual,
  isAtom,
  isVariable,
  isNumber,
  isString,
  isCompound,
  isList,
  termToString,
} from './unification';

export interface BuiltinResult {
  success: boolean;
  substitutions: Substitution[];
  cut?: boolean;
}

type BuiltinHandler = (goal: CompoundTerm, subst: Substitution) => BuiltinResult;

const builtins = new Map<string, BuiltinHandler>();

let builtinVarCounter = 0;

function registerBuiltin(name: string, arity: number, handler: BuiltinHandler): void {
  builtins.set(`${name}/${arity}`, handler);
}

function success(subst: Substitution = new Map()): BuiltinResult {
  return { success: true, substitutions: [subst] };
}

function failure(): BuiltinResult {
  return { success: false, substitutions: [] };
}

function multiSuccess(substitutions: Substitution[]): BuiltinResult {
  return { success: substitutions.length > 0, substitutions };
}

registerBuiltin('true', 0, (_goal, subst) => success(subst));

registerBuiltin('false', 0, () => failure());

registerBuiltin('fail', 0, () => failure());

registerBuiltin('!', 0, (_goal, subst) => ({
  success: true,
  substitutions: [subst],
  cut: true,
}));

registerBuiltin('=', 2, (goal, subst) => {
  const [left, right] = goal.args;
  const result = unify(left, right, subst);
  return result ? success(result) : failure();
});

registerBuiltin('\\=', 2, (goal, subst) => {
  const [left, right] = goal.args;
  const result = unify(left, right, subst);
  return result ? failure() : success(subst);
});

registerBuiltin('==', 2, (goal, subst) => {
  const left = applySubstitution(goal.args[0], subst);
  const right = applySubstitution(goal.args[1], subst);
  return termsEqual(left, right) ? success(subst) : failure();
});

registerBuiltin('\\==', 2, (goal, subst) => {
  const left = applySubstitution(goal.args[0], subst);
  const right = applySubstitution(goal.args[1], subst);
  return !termsEqual(left, right) ? success(subst) : failure();
});

const ARITHMETIC_CONSTANTS: Record<string, () => number> = {
  pi: () => Math.PI,
  e: () => Math.E,
  inf: () => Infinity,
  infinite: () => Infinity,
  nan: () => NaN,
  epsilon: () => Number.EPSILON,
  max_tagged_integer: () => Number.MAX_SAFE_INTEGER,
  random: () => Math.random(),
  random_float: () => Math.random(),
  cputime: () => performance.now() / 1000,
  realtime: () => Math.floor(Date.now() / 1000),
};

function requireInteger(value: number, operator: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`Type error: ${operator} expects integer arguments`);
  }
  return value;
}

function requireNonZero(value: number): number {
  if (value === 0) throw new Error('Division by zero');
  return value;
}

function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

type ArithmeticFunction = (args: number[]) => number;

const UNARY_FUNCTIONS: Record<string, (x: number) => number> = {
  '-': (x) => -x,
  '+': (x) => x,
  abs: Math.abs,
  sign: Math.sign,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  log: Math.log,
  log2: Math.log2,
  floor: Math.floor,
  ceiling: Math.ceil,
  round: roundHalfAwayFromZero,
  truncate: Math.trunc,
  integer: roundHalfAwayFromZero,
  float: (x) => x,
  float_integer_part: Math.trunc,
  float_fractional_part: (x) => x - Math.trunc(x),
  '\\': (x) => ~requireInteger(x, '\\'),
  msb: (x) => Math.floor(Math.log2(requireInteger(x, 'msb'))),
};

const BINARY_FUNCTIONS: Record<string, (x: number, y: number) => number> = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / requireNonZero(y),
  '//': (x, y) => Math.trunc(requireInteger(x, '//') / requireNonZero(requireInteger(y, '//'))),
  div: (x, y) => Math.floor(requireInteger(x, 'div') / requireNonZero(requireInteger(y, 'div'))),
  mod: (x, y) => {
    const a = requireInteger(x, 'mod');
    const b = requireNonZero(requireInteger(y, 'mod'));
    return ((a % b) + b) % b;
  },
  rem: (x, y) => requireInteger(x, 'rem') % requireNonZero(requireInteger(y, 'rem')),
  '**': (x, y) => Math.pow(x, y),
  '^': (x, y) => {
    if (Number.isInteger(x) && Number.isInteger(y) && y < 0 && Math.abs(x) !== 1) {
      throw new Error('Type error: integer ^ negative integer is not an integer');
    }
    return Math.pow(x, y);
  },
  min: Math.min,
  max: Math.max,
  atan2: Math.atan2,
  atan: Math.atan2,
  log: (base, x) => Math.log(x) / Math.log(base),
  copysign: (x, y) => (y < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x)),
  gcd: (x, y) => {
    let a = Math.abs(requireInteger(x, 'gcd'));
    let b = Math.abs(requireInteger(y, 'gcd'));
    while (b !== 0) [a, b] = [b, a % b];
    return a;
  },
  '/\\': (x, y) => requireInteger(x, '/\\') & requireInteger(y, '/\\'),
  '\\/': (x, y) => requireInteger(x, '\\/') | requireInteger(y, '\\/'),
  xor: (x, y) => requireInteger(x, 'xor') ^ requireInteger(y, 'xor'),
  '<<': (x, y) => requireInteger(x, '<<') * 2 ** requireInteger(y, '<<'),
  '>>': (x, y) => Math.floor(requireInteger(x, '>>') / 2 ** requireInteger(y, '>>')),
};

const ARITHMETIC: Record<number, Record<string, ArithmeticFunction>> = {
  1: Object.fromEntries(
    Object.entries(UNARY_FUNCTIONS).map(([name, fn]) => [name, (args: number[]) => fn(args[0])])
  ),
  2: Object.fromEntries(
    Object.entries(BINARY_FUNCTIONS).map(([name, fn]) => [
      name,
      (args: number[]) => fn(args[0], args[1]),
    ])
  ),
};

function evaluateArithmetic(term: Term, subst: Substitution): number {
  const t = applySubstitution(term, subst);

  if (isNumber(t)) return t.value;

  if (isVariable(t)) {
    throw new Error(`Instantiation error: ${t.name} is unbound in arithmetic expression`);
  }

  if (isAtom(t)) {
    const constant = ARITHMETIC_CONSTANTS[t.value];
    if (!constant) throw new Error(`Cannot evaluate arithmetic expression: ${t.value}`);
    return constant();
  }

  if (isCompound(t)) {
    if (t.args.length === 0) {
      const constant = ARITHMETIC_CONSTANTS[t.functor];
      if (constant) return constant();
    }

    const fn = ARITHMETIC[t.args.length]?.[t.functor];
    if (!fn) {
      throw new Error(`Unknown arithmetic function: ${t.functor}/${t.args.length}`);
    }
    return fn(t.args.map((a) => evaluateArithmetic(a, subst)));
  }

  if (isList(t) && t.elements.length === 1 && !t.tail) {
    return evaluateArithmetic(t.elements[0], subst);
  }

  throw new Error(`Cannot evaluate arithmetic expression: ${termToString(t)}`);
}

function evaluateFinite(term: Term, subst: Substitution): number {
  const value = evaluateArithmetic(term, subst);
  if (Number.isNaN(value)) throw new Error('Evaluation error: undefined result');
  return value;
}

registerBuiltin('is', 2, (goal, subst) => {
  try {
    const value = evaluateFinite(goal.args[1], subst);
    const result = unify(goal.args[0], { type: 'number', value }, subst);
    return result ? success(result) : failure();
  } catch {
    return failure();
  }
});

function compareNumbers(
  goal: CompoundTerm,
  subst: Substitution,
  compare: (a: number, b: number) => boolean
): BuiltinResult {
  try {
    const left = evaluateFinite(goal.args[0], subst);
    const right = evaluateFinite(goal.args[1], subst);
    return compare(left, right) ? success(subst) : failure();
  } catch {
    return failure();
  }
}

registerBuiltin('<', 2, (goal, subst) => compareNumbers(goal, subst, (a, b) => a < b));
registerBuiltin('>', 2, (goal, subst) => compareNumbers(goal, subst, (a, b) => a > b));
registerBuiltin('=<', 2, (goal, subst) => compareNumbers(goal, subst, (a, b) => a <= b));
registerBuiltin('>=', 2, (goal, subst) => compareNumbers(goal, subst, (a, b) => a >= b));
registerBuiltin('=:=', 2, (goal, subst) => compareNumbers(goal, subst, (a, b) => a === b));
registerBuiltin('=\\=', 2, (goal, subst) => compareNumbers(goal, subst, (a, b) => a !== b));

registerBuiltin('atom', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isAtom(t) ? success(subst) : failure();
});

registerBuiltin('number', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isNumber(t) ? success(subst) : failure();
});

registerBuiltin('integer', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isNumber(t) && Number.isInteger(t.value) ? success(subst) : failure();
});

registerBuiltin('float', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isNumber(t) && !Number.isInteger(t.value) ? success(subst) : failure();
});

registerBuiltin('compound', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  const isNonEmptyList = isList(t) && (t.elements.length > 0 || t.tail !== undefined);
  return (isCompound(t) && t.args.length > 0) || isNonEmptyList ? success(subst) : failure();
});

registerBuiltin('atomic', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isAtom(t) || isNumber(t) || isString(t) ? success(subst) : failure();
});

registerBuiltin('string', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isString(t) ? success(subst) : failure();
});

registerBuiltin('callable', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isAtom(t) || isCompound(t) ? success(subst) : failure();
});

registerBuiltin('var', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isVariable(t) ? success(subst) : failure();
});

registerBuiltin('nonvar', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return !isVariable(t) ? success(subst) : failure();
});

registerBuiltin('is_list', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isList(t) ? success(subst) : failure();
});

registerBuiltin('ground', 1, (goal, subst) => {
  function isGround(term: Term): boolean {
    const t = applySubstitution(term, subst);
    if (isVariable(t)) return false;
    if (isCompound(t)) return t.args.every(isGround);
    if (isList(t)) {
      return t.elements.every(isGround) && (!t.tail || isGround(t.tail));
    }
    return true;
  }
  return isGround(goal.args[0]) ? success(subst) : failure();
});

function listToArray(list: Term, subst: Substitution): Term[] | null {
  const t = applySubstitution(list, subst);
  if (!isList(t)) return null;

  const elements: Term[] = [...t.elements];

  if (t.tail) {
    const tailElements = listToArray(t.tail, subst);
    if (tailElements === null) return null;
    elements.push(...tailElements);
  }

  return elements;
}

function arrayToList(elements: Term[]): ListTerm {
  return { type: 'list', elements };
}

registerBuiltin('member', 2, (goal, subst) => {
  const elem = goal.args[0];
  const list = applySubstitution(goal.args[1], subst);

  if (!isList(list)) {
    return failure();
  }

  const substitutions: Substitution[] = [];

  let current: Term = list;
  while (isList(current)) {
    for (const item of current.elements) {
      const result = unify(elem, item, subst);
      if (result) {
        substitutions.push(result);
      }
    }
    if (!current.tail) break;
    current = applySubstitution(current.tail, subst);
  }

  return multiSuccess(substitutions);
});

registerBuiltin('append', 3, (goal, subst) => {
  const [list1, list2, result] = goal.args.map((a) => applySubstitution(a, subst));

  if (isList(list1) && isList(list2)) {
    const elements1 = listToArray(list1, subst);
    const elements2 = listToArray(list2, subst);
    if (!elements1 || !elements2) return failure();

    const combined = arrayToList([...elements1, ...elements2]);
    const unifyResult = unify(result, combined, subst);
    return unifyResult ? success(unifyResult) : failure();
  }

  if (isList(result)) {
    const resultElements = listToArray(result, subst);
    if (!resultElements) return failure();

    const substitutions: Substitution[] = [];

    for (let i = 0; i <= resultElements.length; i++) {
      const prefix = arrayToList(resultElements.slice(0, i));
      const suffix = arrayToList(resultElements.slice(i));

      let current = subst;
      const r1 = unify(list1, prefix, current);
      if (!r1) continue;
      current = r1;

      const r2 = unify(list2, suffix, current);
      if (!r2) continue;

      substitutions.push(r2);
    }

    return multiSuccess(substitutions);
  }

  if (isList(list1)) {
    const elements1 = listToArray(list1, subst);
    if (!elements1) return failure();

    const combined: ListTerm = {
      type: 'list',
      elements: elements1,
      tail: list2,
    };
    const unifyResult = unify(result, combined, subst);
    return unifyResult ? success(unifyResult) : failure();
  }

  return failure();
});

registerBuiltin('length', 2, (goal, subst) => {
  const list = applySubstitution(goal.args[0], subst);
  const len = applySubstitution(goal.args[1], subst);

  if (isList(list)) {
    const elements = listToArray(list, subst);
    if (!elements) return failure();

    const result = unify(len, { type: 'number', value: elements.length }, subst);
    return result ? success(result) : failure();
  }

  if (isNumber(len) && Number.isInteger(len.value) && len.value >= 0) {
    const elements: Term[] = [];
    for (let i = 0; i < len.value; i++) {
      elements.push({ type: 'variable', name: `_E${builtinVarCounter++}` });
    }
    const result = unify(list, arrayToList(elements), subst);
    return result ? success(result) : failure();
  }

  return failure();
});

registerBuiltin('reverse', 2, (goal, subst) => {
  const list = applySubstitution(goal.args[0], subst);
  const reversed = applySubstitution(goal.args[1], subst);

  if (isList(list)) {
    const elements = listToArray(list, subst);
    if (!elements) return failure();

    const result = unify(reversed, arrayToList([...elements].reverse()), subst);
    return result ? success(result) : failure();
  }

  if (isList(reversed)) {
    const elements = listToArray(reversed, subst);
    if (!elements) return failure();

    const result = unify(list, arrayToList([...elements].reverse()), subst);
    return result ? success(result) : failure();
  }

  return failure();
});

function termOrder(t: Term): number {
  if (isVariable(t)) return 0;
  if (isNumber(t)) return 1;
  if (isAtom(t)) return 2;
  if (isString(t)) return 3;
  if (isCompound(t) || isList(t)) return 4;
  return 5;
}

function compareTerms(a: Term, b: Term): number {
  const oa = termOrder(a);
  const ob = termOrder(b);
  if (oa !== ob) return oa - ob;
  if (isNumber(a) && isNumber(b)) return a.value - b.value;
  if (isAtom(a) && isAtom(b)) return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (isString(a) && isString(b)) return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (isCompound(a) && isCompound(b)) {
    if (a.args.length !== b.args.length) return a.args.length - b.args.length;
    if (a.functor !== b.functor) return a.functor < b.functor ? -1 : 1;
    for (let i = 0; i < a.args.length; i++) {
      const cmp = compareTerms(a.args[i], b.args[i]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  }
  const sa = termToString(a);
  const sb = termToString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareGoal(goal: CompoundTerm, subst: Substitution): number {
  return compareTerms(
    applySubstitution(goal.args[0], subst),
    applySubstitution(goal.args[1], subst)
  );
}

registerBuiltin('@<', 2, (goal, subst) =>
  compareGoal(goal, subst) < 0 ? success(subst) : failure()
);
registerBuiltin('@>', 2, (goal, subst) =>
  compareGoal(goal, subst) > 0 ? success(subst) : failure()
);
registerBuiltin('@=<', 2, (goal, subst) =>
  compareGoal(goal, subst) <= 0 ? success(subst) : failure()
);
registerBuiltin('@>=', 2, (goal, subst) =>
  compareGoal(goal, subst) >= 0 ? success(subst) : failure()
);

registerBuiltin('compare', 3, (goal, subst) => {
  const order = compareTerms(
    applySubstitution(goal.args[1], subst),
    applySubstitution(goal.args[2], subst)
  );
  const symbol = order < 0 ? '<' : order > 0 ? '>' : '=';
  const result = unify(goal.args[0], { type: 'atom', value: symbol }, subst);
  return result ? success(result) : failure();
});

registerBuiltin('sort', 2, (goal, subst) => {
  const list = applySubstitution(goal.args[0], subst);
  const sorted = goal.args[1];

  if (!isList(list)) return failure();

  const elements = listToArray(list, subst);
  if (!elements) return failure();

  const resolved = elements.map((e) => applySubstitution(e, subst));
  const sortedElements = [...resolved].sort(compareTerms);

  const unique = sortedElements.filter((el, i, arr) => i === 0 || !termsEqual(el, arr[i - 1]));

  const result = unify(sorted, arrayToList(unique), subst);
  return result ? success(result) : failure();
});

registerBuiltin('msort', 2, (goal, subst) => {
  const list = applySubstitution(goal.args[0], subst);
  const sorted = goal.args[1];

  if (!isList(list)) return failure();

  const elements = listToArray(list, subst);
  if (!elements) return failure();

  const resolved = elements.map((e) => applySubstitution(e, subst));
  const sortedElements = [...resolved].sort(compareTerms);

  const result = unify(sorted, arrayToList(sortedElements), subst);
  return result ? success(result) : failure();
});

function nthElement(goal: CompoundTerm, subst: Substitution, base: number): BuiltinResult {
  const index = applySubstitution(goal.args[0], subst);
  const list = applySubstitution(goal.args[1], subst);
  const elem = goal.args[2];

  if (!isList(list)) return failure();
  const elements = listToArray(list, subst);
  if (!elements) return failure();

  if (isVariable(index)) {
    const substitutions: Substitution[] = [];
    elements.forEach((element, i) => {
      const withElement = unify(elem, element, subst);
      if (!withElement) return;
      const withIndex = unify(index, { type: 'number', value: i + base }, withElement);
      if (withIndex) substitutions.push(withIndex);
    });
    return multiSuccess(substitutions);
  }

  if (!isNumber(index) || !Number.isInteger(index.value)) return failure();

  const i = index.value - base;
  if (i < 0 || i >= elements.length) return failure();

  const result = unify(elem, elements[i], subst);
  return result ? success(result) : failure();
}

registerBuiltin('nth0', 3, (goal, subst) => nthElement(goal, subst, 0));

registerBuiltin('nth1', 3, (goal, subst) => nthElement(goal, subst, 1));

function numericList(term: Term, subst: Substitution): number[] | null {
  const t = applySubstitution(term, subst);
  if (!isList(t)) return null;
  const elements = listToArray(t, subst);
  if (!elements) return null;
  const values: number[] = [];
  for (const element of elements) {
    try {
      values.push(evaluateFinite(element, subst));
    } catch {
      return null;
    }
  }
  return values;
}

function unifyNumber(target: Term, value: number, subst: Substitution): BuiltinResult {
  const result = unify(target, { type: 'number', value }, subst);
  return result ? success(result) : failure();
}

registerBuiltin('sum_list', 2, (goal, subst) => {
  const values = numericList(goal.args[0], subst);
  return values
    ? unifyNumber(
        goal.args[1],
        values.reduce((a, b) => a + b, 0),
        subst
      )
    : failure();
});

registerBuiltin('max_list', 2, (goal, subst) => {
  const values = numericList(goal.args[0], subst);
  return values && values.length > 0
    ? unifyNumber(goal.args[1], Math.max(...values), subst)
    : failure();
});

registerBuiltin('min_list', 2, (goal, subst) => {
  const values = numericList(goal.args[0], subst);
  return values && values.length > 0
    ? unifyNumber(goal.args[1], Math.min(...values), subst)
    : failure();
});

function textOf(term: Term): string | null {
  if (isAtom(term) || isString(term)) return term.value;
  if (isNumber(term)) return String(term.value);
  return null;
}

registerBuiltin('atom_length', 2, (goal, subst) => {
  const text = textOf(applySubstitution(goal.args[0], subst));
  return text === null ? failure() : unifyNumber(goal.args[1], [...text].length, subst);
});

registerBuiltin('atom_concat', 3, (goal, subst) => {
  const first = textOf(applySubstitution(goal.args[0], subst));
  const second = textOf(applySubstitution(goal.args[1], subst));

  if (first !== null && second !== null) {
    const result = unify(goal.args[2], { type: 'atom', value: first + second }, subst);
    return result ? success(result) : failure();
  }

  const whole = textOf(applySubstitution(goal.args[2], subst));
  if (whole === null) return failure();

  const substitutions: Substitution[] = [];
  for (let i = 0; i <= whole.length; i++) {
    const withFirst = unify(goal.args[0], { type: 'atom', value: whole.slice(0, i) }, subst);
    if (!withFirst) continue;
    const withSecond = unify(goal.args[1], { type: 'atom', value: whole.slice(i) }, withFirst);
    if (withSecond) substitutions.push(withSecond);
  }
  return multiSuccess(substitutions);
});

registerBuiltin('last', 2, (goal, subst) => {
  const list = applySubstitution(goal.args[0], subst);
  const elem = goal.args[1];

  if (!isList(list)) return failure();

  const elements = listToArray(list, subst);
  if (!elements || elements.length === 0) return failure();

  const result = unify(elem, elements[elements.length - 1], subst);
  return result ? success(result) : failure();
});

registerBuiltin('functor', 3, (goal, subst) => {
  const term = applySubstitution(goal.args[0], subst);
  const name = goal.args[1];
  const arity = goal.args[2];

  if (isCompound(term)) {
    let result = unify(name, { type: 'atom', value: term.functor }, subst);
    if (!result) return failure();
    result = unify(arity, { type: 'number', value: term.args.length }, result);
    return result ? success(result) : failure();
  }

  if (isAtom(term)) {
    let result = unify(name, term, subst);
    if (!result) return failure();
    result = unify(arity, { type: 'number', value: 0 }, result);
    return result ? success(result) : failure();
  }

  if (isNumber(term)) {
    let result = unify(name, term, subst);
    if (!result) return failure();
    result = unify(arity, { type: 'number', value: 0 }, result);
    return result ? success(result) : failure();
  }

  const n = applySubstitution(name, subst);
  const a = applySubstitution(arity, subst);

  if (isAtom(n) && isNumber(a) && Number.isInteger(a.value) && a.value >= 0) {
    if (a.value === 0) {
      const result = unify(term, n, subst);
      return result ? success(result) : failure();
    }

    const args: Term[] = [];
    for (let i = 0; i < a.value; i++) {
      args.push({ type: 'variable', name: `_A${builtinVarCounter++}` });
    }

    const compound: CompoundTerm = {
      type: 'compound',
      functor: n.value,
      args,
    };

    const result = unify(term, compound, subst);
    return result ? success(result) : failure();
  }

  return failure();
});

registerBuiltin('arg', 3, (goal, subst) => {
  const n = applySubstitution(goal.args[0], subst);
  const term = applySubstitution(goal.args[1], subst);
  const arg = goal.args[2];

  if (!isNumber(n) || !isCompound(term)) return failure();

  const index = n.value - 1;
  if (index < 0 || index >= term.args.length) return failure();

  const result = unify(arg, term.args[index], subst);
  return result ? success(result) : failure();
});

registerBuiltin('=..', 2, (goal, subst) => {
  const term = applySubstitution(goal.args[0], subst);
  const list = applySubstitution(goal.args[1], subst);

  if (!isVariable(term)) {
    let elements: Term[];
    if (isCompound(term) && term.args.length > 0) {
      elements = [{ type: 'atom', value: term.functor }, ...term.args];
    } else if (isAtom(term)) {
      elements = [term];
    } else if (isNumber(term)) {
      elements = [term];
    } else if (isString(term)) {
      elements = [term];
    } else {
      return failure();
    }
    const result = unify(goal.args[1], arrayToList(elements), subst);
    return result ? success(result) : failure();
  }

  if (isList(list)) {
    const elements = listToArray(list, subst);
    if (!elements || elements.length === 0) return failure();

    const resolved = elements.map((e) => applySubstitution(e, subst));
    const head = resolved[0];

    let constructed: Term;
    if (resolved.length === 1) {
      constructed = head;
    } else if (isAtom(head)) {
      constructed = {
        type: 'compound',
        functor: head.value,
        args: resolved.slice(1),
      };
    } else {
      return failure();
    }

    const result = unify(goal.args[0], constructed, subst);
    return result ? success(result) : failure();
  }

  return failure();
});

registerBuiltin('copy_term', 2, (goal, subst) => {
  const original = applySubstitution(goal.args[0], subst);
  const copy = goal.args[1];

  function renameCopy(term: Term, mapping: Map<string, string>): Term {
    if (isVariable(term)) {
      if (!mapping.has(term.name)) {
        mapping.set(term.name, `_C${builtinVarCounter++}`);
      }
      return { type: 'variable', name: mapping.get(term.name)! };
    }

    if (isCompound(term)) {
      return {
        type: 'compound',
        functor: term.functor,
        args: term.args.map((a) => renameCopy(a, mapping)),
      };
    }

    if (isList(term)) {
      return {
        type: 'list',
        elements: term.elements.map((e) => renameCopy(e, mapping)),
        tail: term.tail ? renameCopy(term.tail, mapping) : undefined,
      };
    }

    return term;
  }

  const copied = renameCopy(original, new Map());
  const result = unify(copy, copied, subst);
  return result ? success(result) : failure();
});

registerBuiltin('succ', 2, (goal, subst) => {
  const n = applySubstitution(goal.args[0], subst);
  const s = applySubstitution(goal.args[1], subst);

  if (isNumber(n) && Number.isInteger(n.value) && n.value >= 0) {
    const result = unify(s, { type: 'number', value: n.value + 1 }, subst);
    return result ? success(result) : failure();
  }

  if (isNumber(s) && Number.isInteger(s.value) && s.value > 0) {
    const result = unify(n, { type: 'number', value: s.value - 1 }, subst);
    return result ? success(result) : failure();
  }

  return failure();
});

registerBuiltin('plus', 3, (goal, subst) => {
  const x = applySubstitution(goal.args[0], subst);
  const y = applySubstitution(goal.args[1], subst);
  const z = applySubstitution(goal.args[2], subst);

  if (isNumber(x) && isNumber(y)) {
    const result = unify(z, { type: 'number', value: x.value + y.value }, subst);
    return result ? success(result) : failure();
  }

  if (isNumber(x) && isNumber(z)) {
    const result = unify(y, { type: 'number', value: z.value - x.value }, subst);
    return result ? success(result) : failure();
  }

  if (isNumber(y) && isNumber(z)) {
    const result = unify(x, { type: 'number', value: z.value - y.value }, subst);
    return result ? success(result) : failure();
  }

  return failure();
});

const CONTROL_CONSTRUCTS = new Set([
  ',/2',
  ';/2',
  '->/2',
  '\\+/1',
  'not/1',
  'call/1',
  'call/2',
  'call/3',
  'call/4',
  'call/5',
  'call/6',
  'call/7',
  'call/8',
  'findall/3',
  'forall/2',
  'between/3',
]);

export function isControlConstruct(functor: string, arity: number): boolean {
  return CONTROL_CONSTRUCTS.has(`${functor}/${arity}`);
}

export function isBuiltin(functor: string, arity: number): boolean {
  return builtins.has(`${functor}/${arity}`);
}

export function executeBuiltin(goal: CompoundTerm, subst: Substitution): BuiltinResult {
  const key = `${goal.functor}/${goal.args.length}`;
  const handler = builtins.get(key);

  if (!handler) {
    return failure();
  }

  return handler(goal, subst);
}

export function getBuiltinList(): string[] {
  const names = new Set<string>();
  for (const key of [...builtins.keys(), ...CONTROL_CONSTRUCTS]) {
    names.add(key.slice(0, key.lastIndexOf('/')));
  }
  return Array.from(names);
}
