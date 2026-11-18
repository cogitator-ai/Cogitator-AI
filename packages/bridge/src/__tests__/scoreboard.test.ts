import { describe, expect, it } from 'vitest';
import {
  resultLine,
  resultOf,
  resultRow,
  standingWords,
  standingsOf,
  suggestFrom,
  suggestionLines,
  type JobResult,
} from '../scoreboard';
import { DEFAULT_LIMITS, type BridgeJob, type JobReview } from '../types';

const START = Date.parse('2026-11-18T10:00:00.000Z');

function job(patch: Partial<BridgeJob> = {}): BridgeJob {
  return {
    number: 1,
    title: 'Fix the limiter',
    from: 'claude@demo',
    to: 'codex@demo',
    project: '/work/demo',
    cwd: '/work/demo',
    checks: [],
    budget: DEFAULT_LIMITS.budget,
    lettersUsed: 2,
    depth: 1,
    createdAt: new Date(START).toISOString(),
    deadlineAt: new Date(START + 3_600_000).toISOString(),
    endedAt: new Date(START + 300_000).toISOString(),
    taskId: 'task-1',
    state: 'completed',
    updatedAt: new Date(START + 300_000).toISOString(),
    ...patch,
  };
}

function review(patch: Partial<JobReview> = {}): JobReview {
  return {
    job: 2,
    by: 'claude-2@demo',
    at: new Date(START + 400_000).toISOString(),
    blocker: 0,
    major: 0,
    minor: 0,
    nit: 0,
    ...patch,
  };
}

function result(harness: string, outcome: JobResult['outcome'], type = 'code'): JobResult {
  return {
    job: 1,
    agent: `${harness}@demo`,
    harness,
    type,
    project: '/work/demo',
    state: 'completed',
    outcome,
    grounds: [],
    durationMs: 240_000,
    letters: 2,
    person: 0,
    endedAt: new Date(START).toISOString(),
  };
}

function results(harness: string, good: number, bad: number, type = 'code'): JobResult[] {
  return [
    ...Array.from({ length: good }, () => result(harness, 'good', type)),
    ...Array.from({ length: bad }, () => result(harness, 'bad', type)),
  ];
}

describe('resultOf', () => {
  it('takes a job that only says it is done for unknown', () => {
    const found = resultOf(job(), 'codex');
    expect(found).toMatchObject({
      job: 1,
      agent: 'codex@demo',
      harness: 'codex',
      type: 'general',
      state: 'completed',
      outcome: 'unknown',
      grounds: [],
      durationMs: 300_000,
      letters: 2,
      person: 0,
    });
    expect(found?.verified).toBeUndefined();
    expect(found?.findings).toBeUndefined();
    expect(resultLine(found!)).toBe('unknown (it ended, and nobody checked it)');
  });

  it('is good by checks that passed, a clean review, or work that was taken', () => {
    const checked = resultOf(
      job({ verification: { verified: true, checkedAt: 'x', checks: [] } }),
      'codex'
    );
    expect(checked).toMatchObject({ outcome: 'good', verified: true });
    expect(checked?.grounds).toEqual(['its checks passed']);

    const reviewed = resultOf(job({ reviews: [review({ minor: 2, nit: 1 })] }), 'codex');
    expect(reviewed).toMatchObject({
      outcome: 'good',
      findings: { blocker: 0, major: 0, minor: 2, nit: 1 },
    });
    expect(reviewed?.grounds).toEqual(['a review found nothing above minor']);

    const taken = resultOf(
      job({
        worktree: {
          path: '/w',
          branch: 'b',
          base: 'c',
          end: { how: 'accepted', at: 'x', commit: 'abc' },
        },
      }),
      'codex'
    );
    expect(taken?.grounds).toEqual(['its work was taken']);
    expect(resultLine(taken!)).toBe('good (its work was taken)');
  });

  it('is bad when it failed, a check did not pass, or a review found something heavy', () => {
    const failed = resultOf(
      job({ state: 'failed', reason: 'reported as failed', failure: 'reported' }),
      'codex'
    );
    expect(failed).toMatchObject({ outcome: 'bad', state: 'failed' });
    expect(failed?.grounds).toEqual(['it failed: reported as failed']);
    for (const failure of ['silent', 'timeout'] as const) {
      expect(resultOf(job({ state: 'failed', failure }), 'codex')?.outcome).toBe('bad');
    }

    const red = resultOf(
      job({
        verification: {
          verified: false,
          checkedAt: 'x',
          checks: [{ name: 'test', command: 'npm test', ok: false, code: 1 }],
        },
      }),
      'codex'
    );
    expect(red).toMatchObject({ outcome: 'bad', verified: false });

    const heavy = resultOf(
      job({
        verification: { verified: true, checkedAt: 'x', checks: [] },
        reviews: [review({ major: 2 }), review({ job: 3, blocker: 1, minor: 4 })],
        worktree: {
          path: '/w',
          branch: 'b',
          base: 'c',
          end: { how: 'accepted', at: 'x', commit: 'abc' },
        },
      }),
      'codex'
    );
    expect(heavy?.outcome).toBe('bad');
    expect(heavy?.grounds).toEqual(['a review found 1 blocker, 2 major']);
    expect(heavy?.findings).toEqual({ blocker: 1, major: 2, minor: 4, nit: 0 });
  });

  it('holds a check the bridge left out, and work that was dropped, for no evidence', () => {
    const skipped = resultOf(
      job({
        verification: {
          verified: false,
          checkedAt: 'x',
          checks: [{ name: 'test', command: 'npm test', ok: false, skipped: 'not allowed' }],
        },
      }),
      'codex'
    );
    expect(skipped?.outcome).toBe('unknown');
    expect(skipped?.verified).toBeUndefined();

    const dropped = resultOf(
      job({
        worktree: { path: '/w', branch: 'b', base: 'c', end: { how: 'rejected', at: 'x' } },
      }),
      'codex'
    );
    expect(dropped?.outcome).toBe('unknown');

    const empty = resultOf(
      job({
        worktree: { path: '/w', branch: 'b', base: 'c', end: { how: 'accepted', at: 'x' } },
      }),
      'codex'
    );
    expect(empty?.outcome).toBe('unknown');
  });

  it('holds a failure that was not the doing of the agent against nobody', () => {
    const unstarted = resultOf(
      job({
        state: 'failed',
        reason: 'the bridge could not start a codex session: no such file',
        failure: 'other',
        verification: { verified: true, checkedAt: 'x', checks: [] },
      }),
      'codex'
    );
    expect(unstarted).toMatchObject({ outcome: 'unknown', state: 'failed' });
    expect(resultLine(unstarted!)).toBe(
      "unknown (it failed: the bridge could not start a codex session: no such file, which was not its agent's doing)"
    );
    expect(resultOf(job({ state: 'failed', reason: 'old' }), 'codex')?.outcome).toBe('unknown');
  });

  it('keeps no result of a job that says nothing of the work', () => {
    expect(resultOf(job({ state: 'working' }), 'codex')).toBeUndefined();
    expect(resultOf(job({ state: 'canceled' }), 'codex')).toBeUndefined();
    expect(resultOf(job({ recipe: { name: 'build' } }), 'recipe')).toBeUndefined();
    expect(resultOf(job({ checking: { letter: 'l', since: 'x' } }), 'codex')).toBeUndefined();
  });

  it('carries the type and how many times the person was needed', () => {
    const found = resultOf(job({ type: 'docs', personNeeded: 3 }), 'codex');
    expect(found).toMatchObject({ type: 'docs', person: 3 });
    expect(resultRow(found!)).toBe(
      '#1  codex@demo  docs  unknown (it ended, and nobody checked it)  5 min, 2 letters, needed the person 3 times'
    );
    const quick = resultOf(
      job({
        lettersUsed: 1,
        personNeeded: 1,
        verification: { verified: true, checkedAt: 'x', checks: [] },
      }),
      'codex'
    );
    expect(resultRow(quick!)).toBe(
      '#1  codex@demo  general  good (its checks passed)  5 min, 1 letter, needed the person once'
    );
  });
});

describe('standingsOf', () => {
  it('rates by the lower end of the interval, so a few clean jobs do not outrank many', async () => {
    const standings = await standingsOf(
      [...results('codex', 5, 0), ...results('claude-code', 38, 2)],
      { minJobs: 5 }
    );
    expect(standings.map((standing) => standing.harness)).toEqual(['claude-code', 'codex']);
    const [claude, codex] = standings;
    expect(claude).toMatchObject({ scored: 40, good: 38, enough: true, rate: 0.95 });
    expect(codex).toMatchObject({ scored: 5, good: 5, enough: true, rate: 1, high: 1 });
    expect(codex.low).toBeCloseTo(0.5655, 3);
    expect(claude.low).toBeGreaterThan(codex.low ?? 1);
  });

  it('does not rate a harness with too few checked jobs, and counts the unchecked apart', async () => {
    const standings = await standingsOf(
      [
        ...results('codex', 2, 0),
        result('codex', 'unknown'),
        result('codex', 'unknown'),
        ...results('qwen', 6, 1),
      ],
      { minJobs: 5, harnesses: ['codex', 'qwen', 'gemini'] }
    );
    expect(standings.map((standing) => standing.harness)).toEqual(['qwen', 'codex', 'gemini']);
    expect(standings[1]).toMatchObject({ jobs: 4, scored: 2, unknown: 2, enough: false });
    expect(standings[2]).toMatchObject({ jobs: 0, scored: 0, enough: false });
    expect(standings[2].rate).toBeUndefined();
    expect(standings[2].medianMs).toBeUndefined();
    expect(standingWords(standings[0], 5)).toMatch(/^6 of 7 held \(86%, \d+%-\d+%\)$/);
    expect(standingWords(standings[1], 5)).toBe(
      '2 of 2 held, not enough to tell (5 checked jobs are)'
    );
    expect(standingWords(standings[2], 5)).toBe('no job yet');
  });

  it('says what a job took: the median time, letters and calls for the person', async () => {
    const [standing] = await standingsOf(
      [
        { ...result('codex', 'good'), durationMs: 60_000, letters: 2, person: 0 },
        { ...result('codex', 'good'), durationMs: 600_000, letters: 6, person: 1 },
        { ...result('codex', 'bad'), durationMs: 120_000, letters: 4, person: 2 },
      ],
      { minJobs: 1 }
    );
    expect(standing).toMatchObject({ medianMs: 120_000, letters: 4, person: 1 });
  });
});

describe('suggestFrom', () => {
  const options = {
    minJobs: 5,
    windowMs: 60 * 86_400_000,
    harnesses: ['claude-code', 'codex'],
    unavailable: () => undefined,
  };

  it('goes by the jobs of the type when a harness has enough of them', async () => {
    const suggestion = await suggestFrom(
      [
        ...results('codex', 9, 1, 'code'),
        ...results('claude-code', 5, 5, 'code'),
        ...results('claude-code', 20, 0, 'docs'),
      ],
      { ...options, type: 'code' }
    );
    expect(suggestion).toMatchObject({ type: 'code', basis: 'type', best: 'codex' });
    expect(suggestion.candidates.map((candidate) => candidate.harness)).toEqual([
      'codex',
      'claude-code',
    ]);
    expect(suggestion.reason).toContain('codex: 9 of 10 held (90%');
    expect(suggestion.reason).toContain('over code jobs');
    expect(suggestion.reason).toContain('The intervals overlap: the difference is not established');
  });

  it('says so when the intervals do not overlap', async () => {
    const suggestion = await suggestFrom(
      [...results('codex', 40, 0), ...results('claude-code', 5, 35)],
      { ...options, type: 'code' }
    );
    expect(suggestion.best).toBe('codex');
    expect(suggestion.reason).toContain('The intervals do not overlap: the difference holds');
  });

  it('falls back to the jobs of every type, then to the order of the bridge', async () => {
    const unchecked = (harness: string, count: number): JobResult[] =>
      Array.from({ length: count }, () => result(harness, 'unknown'));
    const byAll = await suggestFrom(
      [
        ...results('codex', 2, 0, 'docs'),
        ...results('codex', 6, 0, 'code'),
        ...unchecked('claude-code', 5),
      ],
      { ...options, type: 'docs' }
    );
    expect(byAll).toMatchObject({ basis: 'all', best: 'codex' });
    expect(byAll.reason).toMatch(/^Not enough docs jobs to tell the agents apart/);
    expect(byAll.reason).toContain('No other agent has a checked job to compare');

    const byOrder = await suggestFrom(
      [...results('codex', 3, 0), ...unchecked('codex', 2), ...unchecked('claude-code', 5)],
      { ...options, type: 'code' }
    );
    expect(byOrder).toMatchObject({ basis: 'order', best: 'claude-code' });
    expect(byOrder.reason).toMatch(/^Not enough data to tell the agents apart/);
    expect(byOrder.reason).toContain('claude comes first in the order of the bridge');
    expect(byOrder.candidates.map((candidate) => candidate.harness)).toEqual([
      'claude-code',
      'codex',
    ]);
    expect(byOrder.candidates[1]).toMatchObject({ scored: 3, enough: false });
  });

  it('tries the agent that has done the fewest jobs until each has done enough to compare', async () => {
    const first = await suggestFrom([], { ...options, type: 'code' });
    expect(first).toMatchObject({ basis: 'trial', best: 'claude-code' });
    expect(first.reason).toBe(
      'Not enough data to tell the agents apart: the scoreboard wants 5 finished jobs of each agent before it compares them, and claude has none. It takes this one'
    );

    const later = await suggestFrom(
      [...results('claude-code', 3, 0), ...results('codex', 1, 1, 'docs')],
      { ...options, type: 'code' }
    );
    expect(later).toMatchObject({ basis: 'trial', best: 'codex' });
    expect(later.reason).toContain('and codex has 2. It takes this one');

    const alone = await suggestFrom(results('codex', 1, 0), {
      ...options,
      unavailable: (harness) => (harness === 'claude-code' ? 'out of its limit' : undefined),
    });
    expect(alone).toMatchObject({ basis: 'order', best: 'codex' });
  });

  it('takes an agent nobody checked yet before one that is known to do badly', async () => {
    const suggestion = await suggestFrom(
      [
        ...results('claude-code', 0, 5),
        ...Array.from({ length: 5 }, () => result('codex', 'unknown')),
      ],
      { ...options, type: 'code' }
    );
    expect(suggestion).toMatchObject({ basis: 'type', best: 'codex' });
    expect(suggestion.candidates.map((candidate) => candidate.harness)).toEqual([
      'codex',
      'claude-code',
    ]);
    expect(suggestion.reason).toBe(
      'codex has too few checked code jobs to be rated (5 done, none of them checked), and takes this one all the same: no agent that is rated is known to do better. claude 0 of 5 held (0%, 0%-43%)'
    );
  });

  it('passes over a harness no job can go to, and one the bridge cannot start', async () => {
    const suggestion = await suggestFrom(
      [...results('codex', 10, 0), ...results('claude-code', 6, 2), ...results('gemini', 9, 0)],
      {
        ...options,
        unavailable: (harness) =>
          harness === 'codex' ? 'out of its limit until 15:00' : undefined,
      }
    );
    expect(suggestion.best).toBe('claude-code');
    const byHarness = new Map(
      suggestion.candidates.map((candidate) => [candidate.harness, candidate])
    );
    expect(byHarness.get('codex')).toMatchObject({
      available: false,
      unavailable: 'out of its limit until 15:00',
    });
    expect(byHarness.get('gemini')).toMatchObject({
      available: false,
      unavailable: 'the bridge has no way to start a session of it',
    });
  });

  it('names nobody when no job can go to anyone', async () => {
    const suggestion = await suggestFrom(results('codex', 10, 0), {
      ...options,
      unavailable: () => 'out of its limit',
    });
    expect(suggestion.best).toBeUndefined();
    expect(suggestion.reason).toMatch(/^No job can go to any agent right now/);

    const empty = await suggestFrom([], { ...options, harnesses: [] });
    expect(empty.best).toBeUndefined();
    expect(empty.reason).toBe('The bridge knows no agent it can start a session of');
  });

  it('reads as lines, with the word a job is addressed by and the one auto takes', async () => {
    const suggestion = await suggestFrom(
      [
        ...results('codex', 9, 1),
        ...results('claude-code', 2, 0),
        ...Array.from({ length: 3 }, () => result('claude-code', 'unknown')),
      ],
      { ...options, type: 'code' }
    );
    const lines = suggestionLines(suggestion);
    expect(lines[0]).toBe('How code jobs of the last 60 days went:');
    expect(lines[1]).toMatch(/^ {2}codex {3}9 of 10 held \(90%, \d+%-\d+%\)\. median 4 min/);
    expect(lines[1]).toMatch(/<- auto takes this one$/);
    expect(lines[2]).toMatch(/^ {2}claude {2}2 of 2 held, not enough to tell/);
    expect(lines[2]).toContain('3 more nobody checked');
    expect(lines.at(-1)).toBe(suggestion.reason);
    expect(suggestionLines({ ...suggestion, windowMs: 6 * 3_600_000 })[0]).toBe(
      'How code jobs of the last 6 hours went:'
    );
  });
});
