import { describe, it, expect } from 'vitest';
import type { CompoundTerm } from '@cogitator-ai/types';
import {
  parseTerm,
  parseClause,
  parseProgram,
  parseQuery,
  termFromValue,
  termToValue,
  getBuiltinList,
  KnowledgeBase,
  createResolver,
  executeBuiltin,
} from '../logic';

describe('parseTerm', () => {
  it('parses atoms', () => {
    const result = parseTerm('hello');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'atom', value: 'hello' });
  });

  it('parses quoted atoms', () => {
    const result = parseTerm("'Hello World'");
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'atom', value: 'Hello World' });
  });

  it('parses variables', () => {
    const result = parseTerm('X');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'variable', name: 'X' });
  });

  it('parses underscore-prefixed variables', () => {
    const result = parseTerm('_Name');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'variable', name: '_Name' });
  });

  it('parses anonymous variable _ as unique variable', () => {
    const result = parseTerm('_');
    expect(result.success).toBe(true);
    expect(result.value?.type).toBe('variable');
    if (result.value?.type === 'variable') {
      expect(result.value.name).toMatch(/^_G/);
    }
  });

  it('parses integers', () => {
    const result = parseTerm('42');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'number', value: 42 });
  });

  it('parses negative numbers', () => {
    const result = parseTerm('-7');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'number', value: -7 });
  });

  it('parses floating point numbers', () => {
    const result = parseTerm('3.14');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'number', value: 3.14 });
  });

  it('parses strings', () => {
    const result = parseTerm('"hello world"');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'string', value: 'hello world' });
  });

  it('parses strings with escape sequences', () => {
    const result = parseTerm('"line1\\nline2"');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'string', value: 'line1\nline2' });
  });

  it('parses empty list', () => {
    const result = parseTerm('[]');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'list', elements: [] });
  });

  it('parses list with elements', () => {
    const result = parseTerm('[a, b, c]');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: 'list',
      elements: [
        { type: 'atom', value: 'a' },
        { type: 'atom', value: 'b' },
        { type: 'atom', value: 'c' },
      ],
    });
  });

  it('parses list with head|tail notation', () => {
    const result = parseTerm('[H|T]');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: 'list',
      elements: [{ type: 'variable', name: 'H' }],
      tail: { type: 'variable', name: 'T' },
    });
  });

  it('parses compound terms', () => {
    const result = parseTerm('likes(john, mary)');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: 'compound',
      functor: 'likes',
      args: [
        { type: 'atom', value: 'john' },
        { type: 'atom', value: 'mary' },
      ],
    });
  });

  it('parses nested compound terms', () => {
    const result = parseTerm('f(g(X), h(Y, Z))');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      type: 'compound',
      functor: 'f',
      args: [
        { type: 'compound', functor: 'g', args: [{ type: 'variable', name: 'X' }] },
        {
          type: 'compound',
          functor: 'h',
          args: [
            { type: 'variable', name: 'Y' },
            { type: 'variable', name: 'Z' },
          ],
        },
      ],
    });
  });

  it('parses compound term with zero args as atom', () => {
    const result = parseTerm('hello');
    expect(result.success).toBe(true);
    expect(result.value?.type).toBe('atom');
  });

  it('parses cut', () => {
    const result = parseTerm('!');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({ type: 'atom', value: '!' });
  });

  it('returns error for unexpected token', () => {
    const result = parseTerm(')');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.message).toBeTruthy();
  });
});

describe('parseClause', () => {
  it('parses a fact (head only)', () => {
    const result = parseClause('parent(tom, bob).');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      head: {
        type: 'compound',
        functor: 'parent',
        args: [
          { type: 'atom', value: 'tom' },
          { type: 'atom', value: 'bob' },
        ],
      },
      body: [],
    });
  });

  it('parses an atom fact', () => {
    const result = parseClause('halt.');
    expect(result.success).toBe(true);
    expect(result.value).toEqual({
      head: { type: 'compound', functor: 'halt', args: [] },
      body: [],
    });
  });

  it('parses a rule (head :- body)', () => {
    const result = parseClause('grandparent(X, Z) :- parent(X, Y), parent(Y, Z).');
    expect(result.success).toBe(true);
    expect(result.value?.head).toEqual({
      type: 'compound',
      functor: 'grandparent',
      args: [
        { type: 'variable', name: 'X' },
        { type: 'variable', name: 'Z' },
      ],
    });
    expect(result.value?.body).toHaveLength(2);
    expect(result.value?.body[0]).toEqual({
      type: 'compound',
      functor: 'parent',
      args: [
        { type: 'variable', name: 'X' },
        { type: 'variable', name: 'Y' },
      ],
    });
    expect(result.value?.body[1]).toEqual({
      type: 'compound',
      functor: 'parent',
      args: [
        { type: 'variable', name: 'Y' },
        { type: 'variable', name: 'Z' },
      ],
    });
  });

  it('parses a rule with multiple body goals', () => {
    const result = parseClause('ancestor(X, Z) :- parent(X, Y), ancestor(Y, Z).');
    expect(result.success).toBe(true);
    expect(result.value?.body).toHaveLength(2);
  });

  it('returns error when period is missing', () => {
    const result = parseClause('parent(tom, bob)');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('parseProgram', () => {
  it('parses multiple clauses', () => {
    const program = `
      parent(tom, bob).
      parent(bob, ann).
      grandparent(X, Z) :- parent(X, Y), parent(Y, Z).
    `;
    const result = parseProgram(program);
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(3);
  });

  it('handles line comments', () => {
    const program = `
      % this is a comment
      parent(tom, bob).
      parent(bob, ann). % inline comment
    `;
    const result = parseProgram(program);
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(2);
  });

  it('handles block comments', () => {
    const program = `
      /* multi-line
         comment */
      parent(tom, bob).
    `;
    const result = parseProgram(program);
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(1);
  });

  it('handles empty program', () => {
    const result = parseProgram('');
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(0);
  });

  it('handles program with only comments', () => {
    const result = parseProgram('% just a comment\n');
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(0);
  });

  it('regression: block comment at end of input does not hang', () => {
    const result = parseProgram('parent(tom, bob). /* trailing comment */');
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(1);
  });
});

describe('parseQuery', () => {
  it('parses simple query', () => {
    const result = parseQuery('parent(tom, X)');
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value![0]).toEqual({
      type: 'compound',
      functor: 'parent',
      args: [
        { type: 'atom', value: 'tom' },
        { type: 'variable', name: 'X' },
      ],
    });
  });

  it('parses compound query with multiple goals', () => {
    const result = parseQuery('parent(X, Y), parent(Y, Z)');
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(2);
  });

  it('returns error for invalid input', () => {
    const result = parseQuery(')invalid');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('parses atom-only query', () => {
    const result = parseQuery('halt');
    expect(result.success).toBe(true);
    expect(result.value).toHaveLength(1);
    expect(result.value![0]).toEqual({
      type: 'compound',
      functor: 'halt',
      args: [],
    });
  });
});

describe('regression: unterminated string', () => {
  it('throws error on unterminated double-quoted string', () => {
    const result = parseTerm('"hello');
    expect(result.success).toBe(false);
    expect(result.error!.message).toMatch(/[Uu]nterminated string/);
  });

  it('throws error on unterminated single-quoted atom', () => {
    const result = parseTerm("'hello");
    expect(result.success).toBe(false);
    expect(result.error!.message).toMatch(/[Uu]nterminated string/);
  });
});

describe('termFromValue / termToValue round-trip', () => {
  it('round-trips atoms', () => {
    const original = 'hello';
    const term = termFromValue(original);
    expect(term).toEqual({ type: 'atom', value: 'hello' });
    expect(termToValue(term)).toBe('hello');
  });

  it('round-trips numbers', () => {
    const original = 42;
    const term = termFromValue(original);
    expect(term).toEqual({ type: 'number', value: 42 });
    expect(termToValue(term)).toBe(42);
  });

  it('round-trips booleans', () => {
    expect(termToValue(termFromValue(true))).toBe(true);
    expect(termToValue(termFromValue(false))).toBe(false);
  });

  it('round-trips null/undefined to nil', () => {
    const term = termFromValue(null);
    expect(term).toEqual({ type: 'atom', value: 'nil' });
    expect(termToValue(term)).toBeNull();

    const term2 = termFromValue(undefined);
    expect(term2).toEqual({ type: 'atom', value: 'nil' });
  });

  it('round-trips arrays', () => {
    const original = [1, 2, 3];
    const term = termFromValue(original);
    expect(term.type).toBe('list');
    const back = termToValue(term);
    expect(back).toEqual([1, 2, 3]);
  });

  it('converts objects to key-value list', () => {
    const original = { name: 'alice', age: 30 };
    const term = termFromValue(original);
    expect(term.type).toBe('list');
    if (term.type === 'list') {
      expect(term.elements).toHaveLength(2);
      for (const el of term.elements) {
        expect(el.type).toBe('compound');
        if (el.type === 'compound') {
          expect(el.functor).toBe('=');
          expect(el.args).toHaveLength(2);
        }
      }
    }
  });

  it('converts string with uppercase/special chars to string term', () => {
    const term = termFromValue('Hello World');
    expect(term).toEqual({ type: 'string', value: 'Hello World' });
    expect(termToValue(term)).toBe('Hello World');
  });

  it('handles variable terms via termToValue', () => {
    const result = termToValue({ type: 'variable', name: 'X' });
    expect(result).toBe('?X');
  });

  it('handles compound terms via termToValue', () => {
    const result = termToValue({
      type: 'compound',
      functor: 'likes',
      args: [
        { type: 'atom', value: 'john' },
        { type: 'atom', value: 'mary' },
      ],
    });
    expect(result).toEqual({ functor: 'likes', args: ['john', 'mary'] });
  });
});

describe('getBuiltinList', () => {
  it('returns an array of strings', () => {
    const list = getBuiltinList();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    for (const item of list) {
      expect(typeof item).toBe('string');
    }
  });

  it('includes known builtins', () => {
    const list = getBuiltinList();
    expect(list).toContain('is');
    expect(list).toContain('member');
    expect(list).toContain('append');
    expect(list).toContain('=');
    expect(list).toContain('==');
    expect(list).toContain('true');
    expect(list).toContain('fail');
  });

  it('returns unique names', () => {
    const list = getBuiltinList();
    const unique = new Set(list);
    expect(unique.size).toBe(list.length);
  });
});

describe('regression: division by zero via KnowledgeBase + resolver', () => {
  const div = (a: number, b: number): CompoundTerm => ({
    type: 'compound',
    functor: '/',
    args: [
      { type: 'number', value: a },
      { type: 'number', value: b },
    ],
  });

  const intDiv = (a: number, b: number): CompoundTerm => ({
    type: 'compound',
    functor: '//',
    args: [
      { type: 'number', value: a },
      { type: 'number', value: b },
    ],
  });

  const isGoal = (varName: string, expr: CompoundTerm): CompoundTerm => ({
    type: 'compound',
    functor: 'is',
    args: [{ type: 'variable', name: varName }, expr],
  });

  it('X is 5 / 0 fails gracefully', () => {
    const kb = new KnowledgeBase();
    kb.assertRule({ type: 'compound', functor: 'calc', args: [{ type: 'variable', name: 'X' }] }, [
      isGoal('X', div(5, 0)),
    ]);
    const resolver = createResolver(kb);
    const result = resolver.query([
      { type: 'compound', functor: 'calc', args: [{ type: 'variable', name: 'X' }] },
    ]);
    expect(result.success).toBe(false);
    expect(result.solutions).toHaveLength(0);
  });

  it('X is 5 // 0 (integer division) fails gracefully', () => {
    const kb = new KnowledgeBase();
    kb.assertRule({ type: 'compound', functor: 'calc', args: [{ type: 'variable', name: 'X' }] }, [
      isGoal('X', intDiv(5, 0)),
    ]);
    const resolver = createResolver(kb);
    const result = resolver.query([
      { type: 'compound', functor: 'calc', args: [{ type: 'variable', name: 'X' }] },
    ]);
    expect(result.success).toBe(false);
  });

  it('normal division still works', () => {
    const kb = new KnowledgeBase();
    kb.assertRule({ type: 'compound', functor: 'calc', args: [{ type: 'variable', name: 'X' }] }, [
      isGoal('X', div(10, 2)),
    ]);
    const resolver = createResolver(kb);
    const result = resolver.query([
      { type: 'compound', functor: 'calc', args: [{ type: 'variable', name: 'X' }] },
    ]);
    expect(result.success).toBe(true);
    expect(result.solutions).toHaveLength(1);
    const x = result.solutions[0].get('X');
    expect(x).toEqual({ type: 'number', value: 5 });
  });

  it('division by zero via executeBuiltin returns failure', () => {
    const goal: CompoundTerm = isGoal('X', div(5, 0));
    const result = executeBuiltin(goal, new Map());
    expect(result.success).toBe(false);
    expect(result.substitutions).toHaveLength(0);
  });
});

describe('regression: == structural equality', () => {
  const eq = (left: CompoundTerm['args'][0], right: CompoundTerm['args'][0]): CompoundTerm => ({
    type: 'compound',
    functor: '==',
    args: [left, right],
  });

  it('structurally equal atoms succeed', () => {
    const result = executeBuiltin(
      eq({ type: 'atom', value: 'hello' }, { type: 'atom', value: 'hello' }),
      new Map()
    );
    expect(result.success).toBe(true);
  });

  it('structurally different atoms fail', () => {
    const result = executeBuiltin(
      eq({ type: 'atom', value: 'hello' }, { type: 'atom', value: 'world' }),
      new Map()
    );
    expect(result.success).toBe(false);
  });

  it('structurally equal compound terms succeed', () => {
    const left: CompoundTerm = {
      type: 'compound',
      functor: 'f',
      args: [
        { type: 'atom', value: 'a' },
        { type: 'atom', value: 'b' },
      ],
    };
    const right: CompoundTerm = {
      type: 'compound',
      functor: 'f',
      args: [
        { type: 'atom', value: 'a' },
        { type: 'atom', value: 'b' },
      ],
    };
    const result = executeBuiltin(eq(left, right), new Map());
    expect(result.success).toBe(true);
  });

  it('structurally different compound terms fail', () => {
    const left: CompoundTerm = {
      type: 'compound',
      functor: 'f',
      args: [
        { type: 'atom', value: 'a' },
        { type: 'atom', value: 'b' },
      ],
    };
    const right: CompoundTerm = {
      type: 'compound',
      functor: 'f',
      args: [
        { type: 'atom', value: 'a' },
        { type: 'atom', value: 'c' },
      ],
    };
    const result = executeBuiltin(eq(left, right), new Map());
    expect(result.success).toBe(false);
  });

  it('same variable is structurally equal to itself', () => {
    const result = executeBuiltin(
      eq({ type: 'variable', name: 'X' }, { type: 'variable', name: 'X' }),
      new Map()
    );
    expect(result.success).toBe(true);
  });

  it('different unbound variables are not structurally equal', () => {
    const result = executeBuiltin(
      eq({ type: 'variable', name: 'X' }, { type: 'variable', name: 'Y' }),
      new Map()
    );
    expect(result.success).toBe(false);
  });

  it('== does not unify, only compares structure', () => {
    const result = executeBuiltin(
      eq({ type: 'variable', name: 'X' }, { type: 'atom', value: 'hello' }),
      new Map()
    );
    expect(result.success).toBe(false);
  });

  it('bound variable resolves before comparison', () => {
    const subst = new Map([['X', { type: 'atom' as const, value: 'hello' }]]);
    const result = executeBuiltin(
      eq({ type: 'variable', name: 'X' }, { type: 'atom', value: 'hello' }),
      subst
    );
    expect(result.success).toBe(true);
  });
});
