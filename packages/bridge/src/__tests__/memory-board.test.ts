import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { factLine, type FactBoard } from '../board';
import { memoryBoard } from '../memory';

let board: FactBoard;
let at: number;

const PROJECT = '/work/demo';
const OTHER = '/work/other';

beforeEach(async () => {
  at = Date.parse('2026-11-18T10:00:00.000Z');
  board = await memoryBoard({ store: ':memory:', now: () => new Date((at += 1_000)) });
});

afterEach(async () => {
  await board.close?.();
});

const said = (by: string, job?: number) => ({
  by,
  ...(job !== undefined && { job }),
  at: new Date((at += 1_000)).toISOString(),
});

describe('the board of facts', () => {
  it('keeps a note with who said it, on which job and when, and shows it to the project', async () => {
    const kept = await board.remember({
      kind: 'fact',
      text: 'The limiter tests need Redis on port 6380',
      project: PROJECT,
      source: said('codex@demo', 4),
    });

    expect(kept).toMatchObject({
      kind: 'fact',
      text: 'The limiter tests need Redis on port 6380',
      project: PROJECT,
      source: { by: 'codex@demo', job: 4 },
    });
    expect(kept.job).toBeUndefined();
    expect(await board.recall({ project: PROJECT })).toEqual([kept]);
    expect(await board.recall({ project: OTHER })).toEqual([]);
    expect(factLine(kept)).toBe(
      `The limiter tests need Redis on port 6380 (fact from codex@demo, job #4, ${kept.source.at.slice(0, 10)})`
    );
  });

  it('keeps a note of one job to those who name that job', async () => {
    const open = await board.remember({
      kind: 'fact',
      text: 'CI runs on Node 22',
      project: PROJECT,
      source: said('person'),
    });
    const kept = await board.remember({
      kind: 'fact',
      text: 'The flaky test is skipped for this job',
      project: PROJECT,
      job: 7,
      source: said('claude@demo', 7),
    });

    expect(await board.recall({ project: PROJECT })).toEqual([open]);
    expect(await board.recall({ project: PROJECT, jobs: [8] })).toEqual([open]);
    expect(await board.recall({ project: PROJECT, jobs: [7, 8] })).toEqual([kept, open]);
    expect(factLine(kept)).toContain('kept to that job');
    expect(factLine(open)).toContain('(fact from the person, ');
  });

  it('finds the notes that fit the words best, and the newest first without words', async () => {
    const texts = [
      'The limiter keeps its counters in Redis',
      'Deploys go through Fly, never by hand',
      'The burst limit of the limiter is 3',
    ];
    for (const text of texts) {
      await board.remember({ kind: 'fact', text, project: PROJECT, source: said('codex@demo') });
    }
    await board.remember({
      kind: 'lesson',
      text: 'Mocking Redis hid a race in the limiter: run a real one',
      project: PROJECT,
      source: said('codex@demo', 2),
    });

    expect((await board.recall({ project: PROJECT })).map((fact) => fact.text)).toEqual([
      'Mocking Redis hid a race in the limiter: run a real one',
      ...texts.reverse(),
    ]);
    const fitting = await board.recall({ project: PROJECT, text: 'burst limit' });
    expect(fitting[0].text).toBe('The burst limit of the limiter is 3');
    expect(fitting.map((fact) => fact.text)).not.toContain('Deploys go through Fly, never by hand');
    expect(
      (await board.recall({ project: PROJECT, text: 'limiter', kinds: ['lesson'] })).map(
        (fact) => fact.kind
      )
    ).toEqual(['lesson']);
    expect(await board.recall({ project: PROJECT, limit: 2 })).toHaveLength(2);
    expect(await board.recall({ project: PROJECT, text: 'kubernetes' })).toEqual([]);
  });

  it('lets a note go without deleting it, and finds a note by the start of its id', async () => {
    const kept = await board.remember({
      kind: 'fact',
      text: 'Wrong',
      project: PROJECT,
      source: said('codex@demo'),
    });

    expect(await board.find(kept.id)).toEqual(kept);
    expect(await board.find(kept.id.slice(0, 8))).toEqual(kept);
    expect(await board.find(kept.id.slice(0, 3))).toBeUndefined();
    expect(await board.find('nothing-like-it')).toBeUndefined();

    expect(await board.forget(kept.id)).toBe(true);
    expect(await board.forget(kept.id)).toBe(false);
    expect(await board.forget('nothing-like-it')).toBe(false);
    expect(await board.recall({ project: PROJECT })).toEqual([]);
    expect(await board.find(kept.id)).toBeUndefined();
  });

  it('keeps the outcome of a job as the bridge saw it', async () => {
    const kept = await board.remember({
      kind: 'outcome',
      text: 'Job #3 "Fix the limiter" by codex@demo: completed, verified, work taken',
      project: PROJECT,
      source: said('bridge', 3),
    });

    expect(kept).toMatchObject({ kind: 'outcome', source: { by: 'bridge', job: 3 } });
    expect(await board.recall({ project: PROJECT, kinds: ['outcome'] })).toEqual([kept]);
    expect(await board.recall({ project: PROJECT, kinds: ['fact'] })).toEqual([]);
  });
});
