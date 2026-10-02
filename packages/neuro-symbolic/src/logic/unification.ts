import type {
  Term,
  AtomTerm,
  VariableTerm,
  NumberTerm,
  StringTerm,
  CompoundTerm,
  ListTerm,
  Substitution,
} from '@cogitator-ai/types';
import {
  INFIX_OPERATORS,
  PREFIX_OPERATORS,
  MAX_PRIORITY,
  ARGUMENT_PRIORITY,
  formatAtom,
  escapeQuoted,
} from './operators';

export function isAtom(term: Term): term is AtomTerm {
  return term.type === 'atom';
}

export function isVariable(term: Term): term is VariableTerm {
  return term.type === 'variable';
}

export function isNumber(term: Term): term is NumberTerm {
  return term.type === 'number';
}

export function isString(term: Term): term is StringTerm {
  return term.type === 'string';
}

export function isCompound(term: Term): term is CompoundTerm {
  return term.type === 'compound';
}

export function isList(term: Term): term is ListTerm {
  return term.type === 'list';
}

export function termsEqual(t1: Term, t2: Term): boolean {
  if (t1.type !== t2.type) return false;

  switch (t1.type) {
    case 'atom':
      return (t2 as AtomTerm).value === t1.value;
    case 'variable':
      return (t2 as VariableTerm).name === t1.name;
    case 'number':
      return (t2 as NumberTerm).value === t1.value;
    case 'string':
      return (t2 as StringTerm).value === t1.value;
    case 'compound': {
      const c2 = t2 as CompoundTerm;
      if (t1.functor !== c2.functor) return false;
      if (t1.args.length !== c2.args.length) return false;
      return t1.args.every((arg, i) => termsEqual(arg, c2.args[i]));
    }
    case 'list': {
      const l2 = t2 as ListTerm;
      if (t1.elements.length !== l2.elements.length) return false;
      if (!t1.elements.every((el, i) => termsEqual(el, l2.elements[i]))) return false;
      if (t1.tail && l2.tail) return termsEqual(t1.tail, l2.tail);
      return !t1.tail && !l2.tail;
    }
  }
}

export function occursIn(variable: VariableTerm, term: Term): boolean {
  if (isVariable(term)) {
    return term.name === variable.name;
  }
  if (isCompound(term)) {
    return term.args.some((arg) => occursIn(variable, arg));
  }
  if (isList(term)) {
    if (term.elements.some((el) => occursIn(variable, el))) return true;
    if (term.tail) return occursIn(variable, term.tail);
  }
  return false;
}

export function applySubstitution(term: Term, subst: Substitution): Term {
  return resolveTerm(term, subst, new Set());
}

function resolveTerm(term: Term, subst: Substitution, resolving: Set<string>): Term {
  switch (term.type) {
    case 'variable': {
      if (resolving.has(term.name)) return term;
      const bound = subst.get(term.name);
      if (!bound) return term;
      resolving.add(term.name);
      const resolved = resolveTerm(bound, subst, resolving);
      resolving.delete(term.name);
      return resolved;
    }

    case 'compound':
      return {
        type: 'compound',
        functor: term.functor,
        args: term.args.map((arg) => resolveTerm(arg, subst, resolving)),
      };

    case 'list': {
      const elements = term.elements.map((el) => resolveTerm(el, subst, resolving));
      if (!term.tail) return { type: 'list', elements };

      const tail = resolveTerm(term.tail, subst, resolving);
      if (tail.type !== 'list') return { type: 'list', elements, tail };

      const merged = [...elements, ...tail.elements];
      return tail.tail
        ? { type: 'list', elements: merged, tail: tail.tail }
        : { type: 'list', elements: merged };
    }

    default:
      return term;
  }
}

export function composeSubstitutions(s1: Substitution, s2: Substitution): Substitution {
  const result = new Map<string, Term>();

  for (const [varName, term] of s1) {
    result.set(varName, applySubstitution(term, s2));
  }

  for (const [varName, term] of s2) {
    if (!result.has(varName)) {
      result.set(varName, term);
    }
  }

  return result;
}

function unifyVariable(
  variable: VariableTerm,
  term: Term,
  subst: Substitution
): Substitution | null {
  const varName = variable.name;

  if (subst.has(varName)) {
    return unify(subst.get(varName)!, term, subst);
  }

  if (isVariable(term) && subst.has(term.name)) {
    return unify(variable, subst.get(term.name)!, subst);
  }

  if (occursIn(variable, term)) {
    return null;
  }

  const newSubst = new Map(subst);
  newSubst.set(varName, term);
  return newSubst;
}

export function unify(
  term1: Term,
  term2: Term,
  subst: Substitution = new Map()
): Substitution | null {
  const t1 = applySubstitution(term1, subst);
  const t2 = applySubstitution(term2, subst);

  if (termsEqual(t1, t2)) {
    return subst;
  }

  if (isVariable(t1)) {
    return unifyVariable(t1, t2, subst);
  }

  if (isVariable(t2)) {
    return unifyVariable(t2, t1, subst);
  }

  if (isCompound(t1) && isCompound(t2)) {
    if (t1.functor !== t2.functor) return null;
    if (t1.args.length !== t2.args.length) return null;

    let currentSubst = subst;
    for (let i = 0; i < t1.args.length; i++) {
      const result = unify(t1.args[i], t2.args[i], currentSubst);
      if (result === null) return null;
      currentSubst = result;
    }
    return currentSubst;
  }

  if (isList(t1) && isList(t2)) {
    if (t1.elements.length === 0 && t2.elements.length === 0) {
      if (t1.tail && t2.tail) {
        return unify(t1.tail, t2.tail, subst);
      }
      if (!t1.tail && !t2.tail) {
        return subst;
      }
      if (t1.tail && !t2.tail) {
        return unify(t1.tail, { type: 'list', elements: [] }, subst);
      }
      if (!t1.tail && t2.tail) {
        return unify({ type: 'list', elements: [] }, t2.tail, subst);
      }
    }

    if (t1.elements.length > 0 && t2.elements.length > 0) {
      const headResult = unify(t1.elements[0], t2.elements[0], subst);
      if (headResult === null) return null;

      const tail1: ListTerm = {
        type: 'list',
        elements: t1.elements.slice(1),
        tail: t1.tail,
      };
      const tail2: ListTerm = {
        type: 'list',
        elements: t2.elements.slice(1),
        tail: t2.tail,
      };

      return unify(tail1, tail2, headResult);
    }

    if (t1.elements.length === 0 && t2.elements.length > 0 && t1.tail) {
      return unify(t1.tail, t2, subst);
    }

    if (t2.elements.length === 0 && t1.elements.length > 0 && t2.tail) {
      return unify(t1, t2.tail, subst);
    }

    return null;
  }

  return null;
}

export function getVariables(term: Term): Set<string> {
  const vars = new Set<string>();

  function collect(t: Term): void {
    if (isVariable(t)) {
      vars.add(t.name);
    } else if (isCompound(t)) {
      t.args.forEach(collect);
    } else if (isList(t)) {
      t.elements.forEach(collect);
      if (t.tail) collect(t.tail);
    }
  }

  collect(term);
  return vars;
}

export function renameVariables(term: Term, suffix: string): Term {
  if (isVariable(term)) {
    return { type: 'variable', name: `${term.name}_${suffix}` };
  }

  if (isCompound(term)) {
    return {
      type: 'compound',
      functor: term.functor,
      args: term.args.map((arg) => renameVariables(arg, suffix)),
    };
  }

  if (isList(term)) {
    return {
      type: 'list',
      elements: term.elements.map((el) => renameVariables(el, suffix)),
      tail: term.tail ? renameVariables(term.tail, suffix) : undefined,
    };
  }

  return term;
}

export function substitutionToString(subst: Substitution): string {
  if (subst.size === 0) return '{}';
  const entries = Array.from(subst.entries())
    .map(([name, term]) => `${name} = ${termToString(term)}`)
    .join(', ');
  return `{${entries}}`;
}

export function termToString(term: Term): string {
  return formatTerm(term, MAX_PRIORITY);
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return String(value);
}

function formatTerm(term: Term, maxPriority: number): string {
  switch (term.type) {
    case 'atom':
      return formatAtom(term.value);
    case 'variable':
      return term.name;
    case 'number':
      return formatNumber(term.value);
    case 'string':
      return `"${escapeQuoted(term.value, '"')}"`;
    case 'list': {
      if (term.elements.length === 0 && !term.tail) return '[]';
      const elements = term.elements.map((el) => formatTerm(el, ARGUMENT_PRIORITY)).join(', ');
      return term.tail
        ? `[${elements}|${formatTerm(term.tail, ARGUMENT_PRIORITY)}]`
        : `[${elements}]`;
    }
    case 'compound':
      return formatCompound(term, maxPriority);
  }
}

function formatCompound(term: CompoundTerm, maxPriority: number): string {
  if (term.args.length === 0) return formatAtom(term.functor);

  const infix = term.args.length === 2 ? INFIX_OPERATORS.get(term.functor) : undefined;
  if (infix) {
    const leftMax = infix.type === 'yfx' ? infix.priority : infix.priority - 1;
    const rightMax = infix.type === 'xfy' ? infix.priority : infix.priority - 1;
    const left = formatTerm(term.args[0], leftMax);
    const right = formatTerm(term.args[1], rightMax);
    const text = term.functor === ',' ? `${left}, ${right}` : `${left} ${term.functor} ${right}`;
    return infix.priority > maxPriority ? `(${text})` : text;
  }

  const prefix = term.args.length === 1 ? PREFIX_OPERATORS.get(term.functor) : undefined;
  if (prefix) {
    const operandMax = prefix.type === 'fy' ? prefix.priority : prefix.priority - 1;
    const text = `${term.functor} ${formatTerm(term.args[0], operandMax)}`;
    return prefix.priority > maxPriority ? `(${text})` : text;
  }

  const args = term.args.map((arg) => formatTerm(arg, ARGUMENT_PRIORITY)).join(', ');
  return `${formatAtom(term.functor)}(${args})`;
}
