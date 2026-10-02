import { describe, it, expect } from 'vitest';
import type { Term, Substitution } from '@cogitator-ai/types';
import {
  parseTerm,
  parseClause,
  parseQuery,
  parseProgram,
  termToString,
  applySubstitution,
  createKnowledgeBase,
  KnowledgeBase,
  queryKnowledgeBase,
  createResolver,
  formatSolutions,
  getBuiltinList,
  isControlConstruct,
  executeBuiltin,
} from '../logic';

function solve(program: string, query: string, maxSolutions = 50): string {
  const kb = createKnowledgeBase(program);
  return formatSolutions(queryKnowledgeBase(kb, query, { maxSolutions }));
}

function canonical(term: Term): string {
  return JSON.stringify(term);
}

describe('parser: ISO operator precedence', () => {
  it('binds * tighter than +', () => {
    const result = parseTerm('a + b * c');
    expect(result.value).toEqual({
      type: 'compound',
      functor: '+',
      args: [
        { type: 'atom', value: 'a' },
        {
          type: 'compound',
          functor: '*',
          args: [
            { type: 'atom', value: 'b' },
            { type: 'atom', value: 'c' },
          ],
        },
      ],
    });
  });

  it('parses comparison with arithmetic on the right', () => {
    const result = parseTerm('X = Y + 1');
    expect(result.value?.type).toBe('compound');
    if (result.value?.type === 'compound') {
      expect(result.value.functor).toBe('=');
      expect(result.value.args[1]).toMatchObject({ type: 'compound', functor: '+' });
    }
  });

  it('parses is/2 with full expression', () => {
    expect(solve('', 'X is 2 + 3 * 4')).toBe('X = 14.');
    expect(solve('', 'X is (2 + 3) * 4')).toBe('X = 20.');
    expect(solve('', 'X is 10 - 2 - 3')).toBe('X = 5.');
    expect(solve('', 'X is 2 ** 3')).toBe('X = 8.');
  });

  it('treats ^ as right associative', () => {
    expect(solve('', 'X is 2 ^ 3 ^ 2')).toBe('X = 512.');
  });

  it('gives \\+ lower precedence than =', () => {
    const result = parseTerm('\\+ X = Y');
    expect(result.value).toMatchObject({
      type: 'compound',
      functor: '\\+',
      args: [{ type: 'compound', functor: '=' }],
    });
  });

  it('parses conjunctions and if-then-else inside parentheses', () => {
    const result = parseTerm('(a, b ; c -> d ; e)');
    expect(result.success).toBe(true);
    expect(result.value).toMatchObject({ type: 'compound', functor: ';' });
  });

  it('parses canonical operator notation', () => {
    expect(parseTerm('=(X, Y)').value).toMatchObject({ functor: '=', args: [{}, {}] });
    expect(parseTerm('+(1, 2)').value).toMatchObject({ functor: '+' });
    expect(parseTerm("','(a, b)").value).toMatchObject({ functor: ',' });
  });

  it('distinguishes negative literals from binary minus', () => {
    expect(parseTerm('-3').value).toEqual({ type: 'number', value: -3 });
    expect(parseTerm('5 - 3').value).toMatchObject({ functor: '-' });
    expect(parseTerm('f(-)').value).toMatchObject({ args: [{ type: 'atom', value: '-' }] });
  });

  it('supports exponent floats and doubled quotes', () => {
    expect(parseTerm('1.5e3').value).toEqual({ type: 'number', value: 1500 });
    expect(parseTerm("'don''t'").value).toEqual({ type: 'atom', value: "don't" });
  });
});

describe('parser: queries and clauses', () => {
  it('accepts ?- prefix and ?/. suffix in queries', () => {
    for (const q of ['p(X)?', '?- p(X).', 'p(X).', 'p(X)']) {
      const result = parseQuery(q);
      expect(result.success, q).toBe(true);
      expect(result.value).toHaveLength(1);
    }
  });

  it('flattens top-level conjunction in rule bodies', () => {
    const clause = parseClause('r(X) :- a(X), (b(X) ; c(X)), d.').value!;
    expect(clause.body.map((g) => g.functor)).toEqual(['a', ';', 'd']);
  });

  it('wraps variable goals in call/1', () => {
    const clause = parseClause('apply(G) :- G.').value!;
    expect(clause.body[0]).toEqual({
      type: 'compound',
      functor: 'call',
      args: [{ type: 'variable', name: 'G' }],
    });
  });

  it('rejects trailing input after a single clause', () => {
    expect(parseClause('a. b.').success).toBe(false);
  });

  it('reports the real error location', () => {
    const result = parseProgram('ok(1).\nbad(1 2).');
    expect(result.success).toBe(false);
    expect(result.error!.line).toBe(2);
    expect(result.error!.column).toBeGreaterThan(1);
    expect(result.error!.position).toBeGreaterThan(7);
  });

  it('reports unterminated block comments', () => {
    const result = parseProgram('a. /* never closed');
    expect(result.success).toBe(false);
    expect(result.error!.message).toMatch(/Unterminated block comment/);
  });
});

describe('termToString round-trip', () => {
  const samples = [
    'X is Y + 1',
    '\\+ a = b',
    'foo(\'Hello World\', "say \\"hi\\"", -1, - X, 1 - -1)',
    'a, b ; c -> d',
    'f((a, b))',
    'X = (a :- b)',
    '[a, b|T]',
    "'Upper'(x)",
    'X =.. [foo, 1]',
  ];

  for (const sample of samples) {
    it(`round-trips ${sample}`, () => {
      const parsed = parseTerm(sample);
      expect(parsed.success).toBe(true);
      const printed = termToString(parsed.value!);
      const reparsed = parseTerm(printed);
      expect(reparsed.success).toBe(true);
      expect(canonical(reparsed.value!)).toBe(canonical(parsed.value!));
    });
  }

  it('quotes atoms that would otherwise read as variables', () => {
    expect(termToString({ type: 'atom', value: 'Hello World' })).toBe("'Hello World'");
    expect(termToString({ type: 'atom', value: 'X' })).toBe("'X'");
  });

  it('prints operators infix', () => {
    expect(termToString(parseTerm('X is Y + 1 * 2').value!)).toBe('X is Y + 1 * 2');
    expect(termToString(parseTerm('(a + b) * c').value!)).toBe('(a + b) * c');
  });
});

describe('applySubstitution', () => {
  it('resolves chains longer than 100 bindings', () => {
    const subst: Substitution = new Map();
    for (let i = 0; i < 300; i++) {
      subst.set(`V${i}`, { type: 'variable', name: `V${i + 1}` });
    }
    subst.set('V300', { type: 'atom', value: 'done' });
    expect(applySubstitution({ type: 'variable', name: 'V0' }, subst)).toEqual({
      type: 'atom',
      value: 'done',
    });
  });

  it('normalizes list tails bound to lists', () => {
    const subst: Substitution = new Map([
      ['T', { type: 'list', elements: [{ type: 'atom', value: 'b' }] }],
    ]);
    const term: Term = {
      type: 'list',
      elements: [{ type: 'atom', value: 'a' }],
      tail: { type: 'variable', name: 'T' },
    };
    expect(applySubstitution(term, subst)).toEqual({
      type: 'list',
      elements: [
        { type: 'atom', value: 'a' },
        { type: 'atom', value: 'b' },
      ],
    });
  });

  it('builds long lists through recursion', () => {
    const kb = createKnowledgeBase('upto(0, []) :- !. upto(N, [N|T]) :- M is N - 1, upto(M, T).');
    const result = queryKnowledgeBase(kb, 'upto(150, L), length(L, Len)', { maxDepth: 2000 });
    expect(formatSolutions(result)).toContain('Len = 150');
  });
});

describe('resolver: cut semantics', () => {
  it('keeps cut local to the clause that executes it', () => {
    expect(solve('a(X) :- b(X). a(z). b(1) :- !. b(2).', 'a(X)')).toBe('X = 1 ;\nX = z.');
  });

  it('prunes later clauses of the same predicate', () => {
    const program = `
      classify(X, neg) :- X < 0, !.
      classify(0, zero) :- !.
      classify(_, pos).
    `;
    expect(solve(program, 'classify(-3, C)')).toBe('C = neg.');
    expect(solve(program, 'classify(0, C)')).toBe('C = zero.');
    expect(solve(program, 'classify(4, C)')).toBe('C = pos.');
  });

  it('cuts choice points of goals before the cut only', () => {
    expect(solve('p(1). p(2). q(a). q(b).', 'p(X), !, q(Y)')).toBe('X = 1, Y = a ;\nX = 1, Y = b.');
  });

  it('is opaque inside call/1 and negation', () => {
    expect(solve('p(1). p(2).', 'call((p(X), !)) ; X = 3')).toBe('X = 1 ;\nX = 3.');
  });

  it('treats ! as true when cut is disabled', () => {
    const kb = createKnowledgeBase('b(1) :- !. b(2).');
    const result = queryKnowledgeBase(kb, 'b(X)', { enableCut: false });
    expect(result.solutions).toHaveLength(2);
  });
});

describe('resolver: control constructs', () => {
  it('commits to the condition of if-then-else', () => {
    const program = 'pick(X, R) :- ( X > 0 -> R = pos ; R = nonpos ).';
    expect(solve(program, 'pick(5, R)')).toBe('R = pos.');
    expect(solve(program, 'pick(-1, R)')).toBe('R = nonpos.');
    expect(solve('t :- ( true -> fail ; true ).', 't')).toBe('false.');
  });

  it('fails if-then without else when the condition fails', () => {
    expect(solve('', '( fail -> true )')).toBe('false.');
  });

  it('handles atoms inside disjunctions', () => {
    expect(solve('', '( fail ; true )')).toBe('true.');
  });

  it('collects solutions with findall/3', () => {
    expect(solve('p(1). p(2). p(3).', 'findall(X, p(X), L)')).toBe('L = [1, 2, 3].');
    expect(solve('', 'findall(X, fail, L)')).toBe('L = [].');
    expect(solve('p(1). p(2).', 'findall(X-Y, (p(X), p(Y)), L), length(L, N)')).toContain('N = 4');
  });

  it('is not limited by maxSolutions inside findall', () => {
    const kb = createKnowledgeBase('n(1). n(2). n(3). n(4).');
    const result = queryKnowledgeBase(kb, 'findall(X, n(X), L)', { maxSolutions: 1 });
    expect(formatSolutions(result)).toBe('L = [1, 2, 3, 4].');
  });

  it('supports forall/2', () => {
    expect(solve('p(1). p(2).', 'forall(p(X), X > 0)')).toBe('true.');
    expect(solve('p(1). p(-2).', 'forall(p(X), X > 0)')).toBe('false.');
  });

  it('generates integers lazily with between/3', () => {
    expect(solve('', 'between(1, 3, X)')).toBe('X = 1 ;\nX = 2 ;\nX = 3.');
    expect(solve('', 'between(1, inf, X), X * X > 50, !')).toBe('X = 8.');
    expect(solve('', 'between(1, 3, 2)')).toBe('true.');
  });

  it('supports call/N with extra arguments', () => {
    expect(solve('add(X, Y, Z) :- Z is X + Y.', 'call(add(1), 2, Z)')).toBe('Z = 3.');
  });

  it('stops negation at the first proof', () => {
    const kb = createKnowledgeBase('p(1). p(2). p(3).');
    const resolver = createResolver(kb, { traceExecution: true, maxSolutions: 1 });
    const result = resolver.query(parseQuery('\\+ p(_)').value!);
    expect(result.success).toBe(false);
    expect(result.proofTree!.exploredNodes).toBeLessThan(10);
  });

  it('supports not/1', () => {
    expect(solve('p(1).', 'not(p(2))')).toBe('true.');
  });
});

describe('resolver: reporting', () => {
  it('does not report anonymous or underscore variables', () => {
    const kb = createKnowledgeBase('p(1, a). p(2, b).');
    const result = queryKnowledgeBase(kb, 'p(_, X), p(_Ignored, _)');
    for (const solution of result.solutions) {
      expect([...solution.keys()]).toEqual(['X']);
    }
  });

  it('explains depth-limit exhaustion', () => {
    const kb = createKnowledgeBase('loop(X) :- loop(X).');
    const result = queryKnowledgeBase(kb, 'loop(a)', { maxDepth: 20 });
    expect(result.success).toBe(false);
    expect(result.explanation).toMatch(/depth limit/i);
  });

  it('explains timeouts', () => {
    const kb = createKnowledgeBase('n(0). n(X) :- n(Y), X is Y + 1.');
    const result = queryKnowledgeBase(kb, 'n(X), X < 0', {
      timeout: 50,
      maxDepth: 1_000_000,
    });
    expect(result.success).toBe(false);
    expect(result.explanation).toMatch(/timed out/i);
  });
});

describe('builtins: arithmetic', () => {
  it('follows ISO mod/rem/div/// semantics', () => {
    expect(solve('', 'X is -7 mod 3')).toBe('X = 2.');
    expect(solve('', 'X is 7 mod -3')).toBe('X = -2.');
    expect(solve('', 'X is -7 rem 3')).toBe('X = -1.');
    expect(solve('', 'X is -7 // 2')).toBe('X = -3.');
    expect(solve('', 'X is -7 div 2')).toBe('X = -4.');
  });

  it('fails on undefined results instead of binding NaN', () => {
    expect(solve('', 'X is sqrt(-1)')).toBe('false.');
    expect(solve('', 'X is foo + 1')).toBe('false.');
    expect(solve('', 'X is Y + 1')).toBe('false.');
  });

  it('evaluates extra functions', () => {
    expect(solve('', 'X is max(3, 7) + abs(-2)')).toBe('X = 9.');
    expect(solve('', 'X is gcd(12, 18)')).toBe('X = 6.');
    expect(solve('', 'X is 5 /\\ 3, Y is 5 \\/ 3, Z is 1 << 4')).toBe('X = 1, Y = 7, Z = 16.');
    expect(solve('', 'X is round(-2.5)')).toBe('X = -3.');
  });
});

describe('builtins: terms and lists', () => {
  it('compares terms in standard order', () => {
    expect(solve('', '1 @< a')).toBe('true.');
    expect(solve('', 'b @> a')).toBe('true.');
    expect(solve('', 'compare(O, 1, 2)')).toBe('O = <.');
  });

  it('classifies atomic and compound terms', () => {
    expect(solve('', 'atomic("s")')).toBe('true.');
    expect(solve('', 'compound([a])')).toBe('true.');
    expect(solve('', 'compound([])')).toBe('false.');
    expect(solve('', 'callable(foo)')).toBe('true.');
  });

  it('enumerates indexes in nth0/nth1', () => {
    expect(solve('', 'nth1(I, [a, b, a], a)')).toBe('I = 1 ;\nI = 3.');
    expect(solve('', 'nth0(1, [a, b], E)')).toBe('E = b.');
  });

  it('aggregates numeric lists', () => {
    expect(
      solve('', 'sum_list([1, 2, 3], S), max_list([4, 9, 2], M), min_list([4, 9, 2], N)')
    ).toBe('S = 6, M = 9, N = 2.');
    expect(solve('', 'max_list([], M)')).toBe('false.');
  });

  it('handles atom_length and atom_concat in both modes', () => {
    expect(solve('', 'atom_length(hello, L)')).toBe('L = 5.');
    expect(solve('', 'atom_concat(foo, bar, X)')).toBe('X = foobar.');
    expect(solve('', 'atom_concat(X, Y, ab)')).toBe(
      "X = '', Y = ab ;\nX = a, Y = b ;\nX = ab, Y = ''."
    );
  });

  it('lists names with slashes correctly', () => {
    const list = getBuiltinList();
    expect(list).not.toContain('');
    expect(list).toContain('findall');
    expect(list).toContain('=..');
    expect(isControlConstruct('findall', 3)).toBe(true);
    expect(isControlConstruct('member', 2)).toBe(false);
  });

  it('executeBuiltin still exposes deterministic builtins', () => {
    const result = executeBuiltin(parseQuery('X is 2 * 21').value![0], new Map());
    expect(result.success).toBe(true);
    expect(result.substitutions[0].get('X')).toEqual({ type: 'number', value: 42 });
  });
});

describe('KnowledgeBase hardening', () => {
  it('distinguishes quoted numeric atoms from numbers', () => {
    const kb = new KnowledgeBase();
    kb.assert("v('1').");
    kb.assert('v(1).');
    expect(kb.getClauses('v', 1)).toHaveLength(2);
  });

  it('throws when createKnowledgeBase receives invalid program', () => {
    expect(() => createKnowledgeBase('broken(.')).toThrow(/Failed to load logic program/);
  });

  it('validates imported JSON', () => {
    expect(() => KnowledgeBase.import('{"clauses": [{"head": 1}]}')).toThrow(
      /Invalid knowledge base export/
    );
    const kb = createKnowledgeBase('p(1). q(X) :- p(X).');
    const restored = KnowledgeBase.import(kb.export());
    expect(formatSolutions(queryKnowledgeBase(restored, 'q(X)'))).toBe('X = 1.');
  });
});
