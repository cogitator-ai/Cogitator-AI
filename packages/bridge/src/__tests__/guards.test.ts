import { describe, expect, it } from 'vitest';
import {
  deliveryBackoff,
  exhaustedBudget,
  formatDuration,
  nextDepth,
  resolveBudget,
  resolveLimits,
} from '../guards';
import { expectationOf, renderLetter, repeats, signatureOf, titleOf } from '../letters';
import { DEFAULT_LIMITS, type Letter } from '../types';
import { at, letterInput, T0 } from './helpers';

describe('limits', () => {
  it('takes the defaults for what is not given', () => {
    const limits = resolveLimits(DEFAULT_LIMITS, { maxDepth: 2, budget: { letters: 10 } });

    expect(limits.maxDepth).toBe(2);
    expect(limits.budget).toEqual({ ...DEFAULT_LIMITS.budget, letters: 10 });
    expect(limits.deliveryAttempts).toBe(DEFAULT_LIMITS.deliveryAttempts);
  });

  it('refuses a default budget over the most a job may ask for, and a depth below 1', () => {
    expect(() => resolveLimits(DEFAULT_LIMITS, { budget: { letters: 501 } })).toThrow(
      /over the most/
    );
    expect(() => resolveLimits(DEFAULT_LIMITS, { maxDepth: 0 })).toThrow(/at least 1/);
  });
});

describe('depth', () => {
  it('is 1 for an agent that carries out nothing, one more than the deepest job otherwise', () => {
    expect(nextDepth([], DEFAULT_LIMITS)).toBe(1);
    expect(nextDepth([1], DEFAULT_LIMITS)).toBe(2);
    expect(nextDepth([1, 2], DEFAULT_LIMITS)).toBe(3);
  });

  it('stops at the limit', () => {
    expect(() => nextDepth([3], DEFAULT_LIMITS)).toThrow(
      expect.objectContaining({ code: 'depth_exceeded', data: { depth: 4, maxDepth: 3 } })
    );
  });
});

describe('budget', () => {
  it('fills what a job did not ask for from the defaults', () => {
    expect(resolveBudget({ letters: 5 }, DEFAULT_LIMITS)).toEqual({
      ...DEFAULT_LIMITS.budget,
      letters: 5,
    });
    expect(resolveBudget(undefined, DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS.budget);
  });

  it('refuses more than a job may have, and nonsense', () => {
    expect(() => resolveBudget({ letters: 501 }, DEFAULT_LIMITS)).toThrow(/over the most/);
    expect(() => resolveBudget({ durationMs: 0 }, DEFAULT_LIMITS)).toThrow(/positive whole number/);
    expect(() => resolveBudget({ letters: 1.5 }, DEFAULT_LIMITS)).toThrow(/positive whole number/);
  });

  it('runs out of letters at the limit and of time at the deadline', () => {
    const job = {
      budget: { ...DEFAULT_LIMITS.budget, letters: 3 },
      lettersUsed: 2,
      deadlineAt: at(1000),
    };

    expect(exhaustedBudget(job, T0)).toBeUndefined();
    expect(exhaustedBudget({ ...job, lettersUsed: 3 }, T0)).toBe('letters');
    expect(exhaustedBudget(job, T0 + 999)).toBeUndefined();
    expect(exhaustedBudget(job, T0 + 1000)).toBe('time');
  });
});

describe('delivery backoff', () => {
  it('doubles from the first wait up to the longest', () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((attempts) =>
      deliveryBackoff(attempts, DEFAULT_LIMITS)
    );
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });
});

describe('formatDuration', () => {
  it('reads as seconds, minutes or hours', () => {
    expect(formatDuration(20_000)).toBe('20s');
    expect(formatDuration(30 * 60_000)).toBe('30 min');
    expect(formatDuration(4 * 3_600_000)).toBe('4 h');
  });
});

describe('letters', () => {
  const letter: Letter = {
    ...letterInput({
      id: 'ltr_9',
      kind: 'question',
      from: 'codex@demo',
      to: 'claude@demo',
      job: 12,
    }),
    seq: 1,
  };

  it('start with a line that says what they are and that no person typed them', () => {
    const rendered = renderLetter(
      { ...letter, body: 'Mock Redis\nor run a real one?' },
      { title: 'Write "the" tests' }
    );
    const [first, ...rest] = rendered.text.split('\n');

    expect(first).toBe(
      `[agent bridge] job #12 "Write 'the' tests" | question from codex@demo to claude@demo | letter ltr_9 | not typed by the user`
    );
    expect(rest.join('\n')).toBe('Mock Redis\nor run a real one?');
  });

  it('name the bridge as the sender of its own notes, and keep a long title on one line', () => {
    const signature = signatureOf(
      { ...letter, kind: 'note', from: 'bridge' },
      { title: 'Line one\n  line two' }
    );
    expect(signature).toContain('note from the bridge to claude@demo');
    expect(signature).toContain('"Line one line two"');
    expect(signature).not.toContain('\n');
  });

  it('take their title from the first line of the body, cut to fit', () => {
    expect(titleOf('  Write the tests\nfor the limiter')).toBe('Write the tests');
    expect(titleOf('x'.repeat(200))).toHaveLength(80);
    expect(titleOf('x'.repeat(200)).endsWith('...')).toBe(true);
  });

  it('wait for a pickup, a reply or nothing by kind', () => {
    expect(expectationOf('task')).toBe('pickup');
    expect(expectationOf('question')).toBe('reply');
    expect(expectationOf('permission')).toBe('reply');
    expect(
      ['answer', 'report', 'note'].map((kind) => expectationOf(kind as Letter['kind']))
    ).toEqual(['none', 'none', 'none']);
  });

  it('repeat the one before when kind and words are the same, whatever the spacing and case', () => {
    const previous = { kind: 'note' as const, body: 'Please  fix the\ntest' };

    expect(repeats(previous, 'note', 'please fix the test')).toBe(true);
    expect(repeats(previous, 'question', 'please fix the test')).toBe(false);
    expect(repeats(previous, 'note', 'please fix the tests')).toBe(false);
    expect(repeats(undefined, 'note', 'anything')).toBe(false);
  });
});
