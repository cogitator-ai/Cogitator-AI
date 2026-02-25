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

function evaluateArithmetic(term: Term, subst: Substitution): number {
  const t = applySubstitution(term, subst);

  if (isNumber(t)) {
    return t.value;
  }

  if (isCompound(t)) {
    const args = t.args.map((a) => evaluateArithmetic(a, subst));

    switch (t.functor) {
      case '+':
        return args[0] + args[1];
      case '-':
        if (args.length === 1) return -args[0];
        return args[0] - args[1];
      case '*':
        return args[0] * args[1];
      case '/':
        if (args[1] === 0) throw new Error('Division by zero');
        return args[0] / args[1];
      case '//':
        if (args[1] === 0) throw new Error('Division by zero');
        return Math.floor(args[0] / args[1]);
      case 'mod':
        if (args[1] === 0) throw new Error('Division by zero');
        return args[0] % args[1];
      case '^':
      case '**':
        return Math.pow(args[0], args[1]);
      case 'abs':
        return Math.abs(args[0]);
      case 'sign':
        return Math.sign(args[0]);
      case 'min':
        return Math.min(...args);
      case 'max':
        return Math.max(...args);
      case 'sqrt':
        return Math.sqrt(args[0]);
      case 'sin':
        return Math.sin(args[0]);
      case 'cos':
        return Math.cos(args[0]);
      case 'tan':
        return Math.tan(args[0]);
      case 'log':
        return Math.log(args[0]);
      case 'exp':
        return Math.exp(args[0]);
      case 'floor':
        return Math.floor(args[0]);
      case 'ceiling':
        return Math.ceil(args[0]);
      case 'round':
        return Math.round(args[0]);
      case 'truncate':
        return Math.trunc(args[0]);
      case 'random':
        return Math.random();
      case 'pi':
        return Math.PI;
      case 'e':
        return Math.E;
      default:
        throw new Error(`Unknown arithmetic operator: ${t.functor}`);
    }
  }

  throw new Error(`Cannot evaluate arithmetic expression: ${termToString(t)}`);
}

registerBuiltin('is', 2, (goal, subst) => {
  try {
    const value = evaluateArithmetic(goal.args[1], subst);
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
    const left = evaluateArithmetic(goal.args[0], subst);
    const right = evaluateArithmetic(goal.args[1], subst);
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
  return isCompound(t) && t.args.length > 0 ? success(subst) : failure();
});

registerBuiltin('atomic', 1, (goal, subst) => {
  const t = applySubstitution(goal.args[0], subst);
  return isAtom(t) || isNumber(t) ? success(subst) : failure();
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

  const elements = listToArray(list, subst);
  if (!elements) return failure();

  const substitutions: Substitution[] = [];
  for (const item of elements) {
    const result = unify(elem, item, subst);
    if (result) {
      substitutions.push(result);
    }
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
      elements.push({ type: 'variable', name: `_E${i}` });
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
  return termToString(a).localeCompare(termToString(b));
}

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

registerBuiltin('nth0', 3, (goal, subst) => {
  const index = applySubstitution(goal.args[0], subst);
  const list = applySubstitution(goal.args[1], subst);
  const elem = goal.args[2];

  if (!isNumber(index) || !Number.isInteger(index.value) || !isList(list)) return failure();

  const elements = listToArray(list, subst);
  if (!elements) return failure();

  const i = index.value;
  if (i < 0 || i >= elements.length) return failure();

  const result = unify(elem, elements[i], subst);
  return result ? success(result) : failure();
});

registerBuiltin('nth1', 3, (goal, subst) => {
  const index = applySubstitution(goal.args[0], subst);
  const list = applySubstitution(goal.args[1], subst);
  const elem = goal.args[2];

  if (!isNumber(index) || !Number.isInteger(index.value) || !isList(list)) return failure();

  const elements = listToArray(list, subst);
  if (!elements) return failure();

  const i = index.value - 1;
  if (i < 0 || i >= elements.length) return failure();

  const result = unify(elem, elements[i], subst);
  return result ? success(result) : failure();
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
      args.push({ type: 'variable', name: `_A${i}` });
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

registerBuiltin('copy_term', 2, (goal, subst) => {
  const original = applySubstitution(goal.args[0], subst);
  const copy = goal.args[1];

  function renameCopy(term: Term, mapping: Map<string, string>): Term {
    if (isVariable(term)) {
      if (!mapping.has(term.name)) {
        mapping.set(term.name, `_C${mapping.size}`);
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
  return Array.from(builtins.keys())
    .map((key) => {
      const [name] = key.split('/');
      return name;
    })
    .filter((v, i, a) => a.indexOf(v) === i);
}
