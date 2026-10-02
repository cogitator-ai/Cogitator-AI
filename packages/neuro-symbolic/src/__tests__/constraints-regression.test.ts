import { describe, it, expect } from 'vitest';
import type { SolverResult } from '@cogitator-ai/types';
import {
  ConstraintBuilder,
  solveSAT,
  solveWithZ3,
  isZ3Available,
  allDifferent,
  atMost,
  exactly,
  ite,
  sum,
  solve,
  parseNLConstraintsResponse,
} from '../constraints';

function assignments(result: SolverResult): Record<string, boolean | number> {
  expect(result.status).toBe('sat');
  if (result.status !== 'sat') throw new Error(`expected sat, got ${result.status}`);
  return result.model.assignments;
}

describe('ConstraintBuilder validation', () => {
  it('rejects duplicate variable names', () => {
    const builder = ConstraintBuilder.create();
    builder.int('x', 0, 5);
    expect(() => builder.bool('x')).toThrow(/already declared/);
  });

  it('rejects empty domains', () => {
    expect(() => ConstraintBuilder.create().int('x', 5, 1)).toThrow(/empty domain/);
  });

  it('rejects invalid bit-vector widths', () => {
    expect(() => ConstraintBuilder.create().bitvec('v', 0)).toThrow(/positive integer width/);
  });
});

describe('simple-sat solver: exhaustive finite domains', () => {
  it('proves unsatisfiability of integer problems', () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x', 0, 5);
    const y = b.int('y', 0, 5);
    b.assert(x.add(y).eq(20));
    expect(solveSAT(b.build()).status).toBe('unsat');
  });

  it('respects negative-only domains', () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x', -10, -1);
    b.assert(x.lt(-5));
    const values = assignments(solveSAT(b.build()));
    expect(values.x).toBeLessThan(-5);
    expect(values.x).toBeGreaterThanOrEqual(-10);
  });

  it('finds the optimum objective', () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x', 0, 10);
    const y = b.int('y', 0, 10);
    b.assert(x.add(y).lte(12));
    b.maximize(x.mul(2).add(y));
    const result = solveSAT(b.build());
    expect(result.status).toBe('sat');
    if (result.status === 'sat') expect(result.model.objectiveValue).toBe(22);
  });

  it('minimizes soft constraint violations', () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x', 0, 10);
    b.soft(x.eq(3), 5);
    b.soft(x.eq(7), 1);
    expect(assignments(solveSAT(b.build())).x).toBe(3);
  });

  it('solves mixed bool/int cardinality problems', () => {
    const b = ConstraintBuilder.create();
    const flags = b.boolArray('f', 4);
    const n = b.int('n', 0, 4);
    b.assert(exactly(2, ...flags));
    b.assert(n.eq(sum(...flags.map((f) => ite(f, 1, 0)))));
    const values = assignments(solveSAT(b.build()));
    expect(values.n).toBe(2);
    expect(flags.filter((_, i) => values[`f_${i}`] === true)).toHaveLength(2);
  });

  it('reports duplicate declarations in raw problems', () => {
    const result = solveSAT({
      id: 'dup',
      variables: [
        { name: 'x', type: 'bool' },
        { name: 'x', type: 'bool' },
      ],
      constraints: [],
    });
    expect(result.status).toBe('error');
  });
});

describe('simple-sat solver: local search', () => {
  it('handles real-valued variables', () => {
    const b = ConstraintBuilder.create();
    const r = b.real('r', 0, 10);
    b.assert(r.gt(4.5));
    b.assert(r.lt(5.5));
    const values = assignments(solveSAT(b.build(), { randomSeed: 7 }));
    expect(values.r).toBeGreaterThan(4.5);
    expect(values.r).toBeLessThan(5.5);
  });
});

describe('solve() dispatcher', () => {
  it('passes only solver options to the SAT fallback', async () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x', 1, 3);
    b.assert(x.eq(2));
    const result = await solve(b.build(), { solver: 'simple-sat', timeout: 1000 });
    expect(assignments(result).x).toBe(2);
  });
});

describe('parseNLConstraintsResponse', () => {
  it('drops malformed entries instead of crashing', () => {
    const parsed = parseNLConstraintsResponse(
      'Here {not json} is the model: {"variables": [{"name": "x", "type": "int", "domain": {"min": "a", "max": 5}}, {"type": "bool"}], "constraints": "oops", "objective": {"type": "maximize", "expression": "x"}}'
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.variables).toEqual([{ name: 'x', type: 'int', domain: { max: 5 } }]);
    expect(parsed!.constraints).toEqual([]);
    expect(parsed!.objective).toEqual({ type: 'maximize', expression: 'x' });
  });
});

const z3Available = await isZ3Available();

describe.skipIf(!z3Available)('Z3 backend', () => {
  it('solves mixed int/real/bool problems with optimization', async () => {
    const b = ConstraintBuilder.create('mixed');
    const x = b.int('x', 0, 10);
    const y = b.int('y', 0, 10);
    const r = b.real('r', 0, 5);
    const p = b.bool('p');
    b.assert(x.add(y).eq(15));
    b.assert(r.gt(1.5));
    b.assert(r.add(x).lt(12));
    b.assert(p);
    b.maximize(x);

    const result = await solveWithZ3(b.build());
    const values = assignments(result);
    expect(values.x).toBe(10);
    expect(values.y).toBe(5);
    expect(values.p).toBe(true);
    expect(values.r as number).toBeGreaterThan(1.5);
    expect(values.r as number).toBeLessThan(2);
    if (result.status === 'sat') expect(result.model.objectiveValue).toBe(10);
  });

  it('detects unsatisfiability', async () => {
    const b = ConstraintBuilder.create();
    const a = b.bool('a');
    b.assert(a);
    b.assert(a.not());
    expect((await solveWithZ3(b.build())).status).toBe('unsat');
  });

  it('treats soft constraints as soft without an objective', async () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x', 0, 10);
    b.soft(x.eq(3), 2);
    b.soft(x.eq(5), 1);
    expect(assignments(await solveWithZ3(b.build())).x).toBe(3);
  });

  it('supports allDifferent, cardinality and ite', async () => {
    const b = ConstraintBuilder.create();
    const q = b.intArray('q', 3, 1, 3);
    const flags = b.boolArray('f', 3);
    b.assert(allDifferent(...q));
    b.assert(q[0].gt(q[1]));
    b.assert(atMost(1, ...flags));
    b.assert(flags[1]);
    const z = b.int('z', -5, 5);
    const absZ = b.int('absZ');
    b.assert(absZ.eq(ite(z.gt(0), z, z.mul(-1))));
    b.assert(absZ.eq(4));
    b.assert(z.lt(0));

    const values = assignments(await solveWithZ3(b.build()));
    expect(new Set([values.q_0, values.q_1, values.q_2]).size).toBe(3);
    expect(values.q_0 as number).toBeGreaterThan(values.q_1 as number);
    expect([values.f_0, values.f_1, values.f_2]).toEqual([false, true, false]);
    expect(values.z).toBe(-4);
  });

  it('handles unsigned bit-vector arithmetic', async () => {
    const b = ConstraintBuilder.create();
    const v = b.bitvec('v', 8);
    b.assert(v.gt(200));
    b.assert(v.mod(7).eq(3));
    const values = assignments(await solveWithZ3(b.build()));
    expect(values.v as number).toBeGreaterThan(200);
    expect((values.v as number) % 7).toBe(3);
  });

  it('returns an error for ill-typed constraints', async () => {
    const b = ConstraintBuilder.create();
    const x = b.int('x');
    b.assert(x.add(1));
    const result = await solveWithZ3(b.build());
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/boolean/);
  });

  it('is used by default through solve()', async () => {
    const b = ConstraintBuilder.create();
    const x = b.real('x', -3, 3);
    b.assert(x.abs().gte(2.5));
    b.assert(x.add(1).lt(0));
    const values = assignments(await solve(b.build()));
    expect(values.x as number).toBeLessThanOrEqual(-2.5);
  });
});
