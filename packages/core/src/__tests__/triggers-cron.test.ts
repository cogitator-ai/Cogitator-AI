import { describe, expect, it } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import {
  experimental_createCronEngine,
  experimental_loadCronEngine,
  planOccurrences,
} from '../triggers/cron';

const engine = experimental_createCronEngine(CronExpressionParser);
const at = (iso: string) => Date.parse(iso);

describe('cron engine', () => {
  it('takes 5 fields, 6 fields with seconds and presets', () => {
    expect(engine.next('0 9 * * *', at('2026-03-02T08:00:00Z'), 'UTC')).toBe(
      at('2026-03-02T09:00:00Z')
    );
    expect(engine.next('*/2 * * * * *', at('2026-03-02T08:00:00Z'), 'UTC')).toBe(
      at('2026-03-02T08:00:02Z')
    );
    expect(engine.next('@daily', at('2026-03-02T08:00:00Z'), 'UTC')).toBe(
      at('2026-03-03T00:00:00Z')
    );
    expect(engine.next('@hourly', at('2026-03-02T08:10:00Z'), 'UTC')).toBe(
      at('2026-03-02T09:00:00Z')
    );
    expect(engine.next('0 0 L * *', at('2026-02-10T00:00:00Z'), 'UTC')).toBe(
      at('2026-02-28T00:00:00Z')
    );
  });

  it('computes in a time zone, across daylight saving', () => {
    expect(engine.next('0 9 * * *', at('2026-01-10T00:00:00Z'), 'Europe/Moscow')).toBe(
      at('2026-01-10T06:00:00Z')
    );
    const spring = engine.next('30 2 * * *', at('2026-03-08T05:00:00Z'), 'America/New_York');
    expect(new Date(spring).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    const fall = engine.between(
      '30 1 * * *',
      at('2026-11-01T04:00:00Z'),
      at('2026-11-01T08:00:00Z'),
      'America/New_York'
    );
    expect(fall).toEqual([at('2026-11-01T05:30:00Z')]);
  });

  it('takes presets of its own on top of the parser', () => {
    const custom = experimental_createCronEngine(CronExpressionParser, {
      presets: { '@every_5_minutes': '*/5 * * * *' },
    });
    expect(custom.normalize('@EVERY_5_MINUTES')).toBe('*/5 * * * *');
    expect(custom.next('@every_5_minutes', at('2026-03-02T08:01:00Z'), 'UTC')).toBe(
      at('2026-03-02T08:05:00Z')
    );
  });

  it('says what is wrong with an expression or a time zone', () => {
    expect(engine.problem('0 12 * * *')).toBeUndefined();
    expect(engine.problem('@weekly')).toBeUndefined();
    expect(engine.problem('not a cron')).toMatch(/^Invalid cron expression/);
    expect(engine.problem('* * *')).toMatch(/has 3 fields, cron takes 5 or 6/);
    expect(engine.problem('61 * * * *')).toMatch(/Invalid cron expression/);
    expect(engine.problem('0 9 * * *', 'Mars/Olympus')).toMatch(/Unknown time zone/);
    expect(engine.problem('')).toMatch(/Invalid cron expression: it is empty/);
  });

  it('lists occurrences before and between times', () => {
    expect(engine.previous('0 * * * *', at('2026-03-02T10:00:00Z'), 'UTC', 3)).toEqual([
      at('2026-03-02T10:00:00Z'),
      at('2026-03-02T09:00:00Z'),
      at('2026-03-02T08:00:00Z'),
    ]);
    expect(
      engine.between('0 * * * *', at('2026-03-02T08:00:00Z'), at('2026-03-02T10:00:00Z'), 'UTC')
    ).toEqual([at('2026-03-02T09:00:00Z'), at('2026-03-02T10:00:00Z')]);
  });

  it('loads cron-parser lazily as an optional peer', async () => {
    const loaded = await experimental_loadCronEngine();
    expect(loaded.next('0 9 * * *', at('2026-03-02T08:00:00Z'), 'UTC')).toBe(
      at('2026-03-02T09:00:00Z')
    );
    expect(await experimental_loadCronEngine()).toBe(loaded);
  });
});

describe('planOccurrences', () => {
  it('catches up an hour that repeats in the fall once, as the schedule fires it (New York)', () => {
    const plan = planOccurrences(
      {
        firesAt: at('2026-10-31T05:30:00Z'),
        cron: '30 1 * * *',
        timezone: 'America/New_York',
        catchUp: 'all',
      },
      engine,
      { now: at('2026-11-01T08:00:00Z'), graceMs: 0 }
    );
    expect(plan.fire.map((time) => new Date(time).toISOString())).toEqual([
      '2026-10-31T05:30:00.000Z',
      '2026-11-01T05:30:00.000Z',
    ]);
    expect(plan.missed).toBe(false);
  });

  it('catches up the spring occurrence that moved past the skipped hour, not a stale one (New York)', () => {
    const plan = planOccurrences(
      {
        firesAt: at('2026-03-07T07:30:00Z'),
        cron: '30 2 * * *',
        timezone: 'America/New_York',
        catchUp: 'latest',
      },
      engine,
      { now: at('2026-03-08T09:00:00Z'), graceMs: 0 }
    );
    expect(plan.fire.map((time) => new Date(time).toISOString())).toEqual([
      '2026-03-08T07:30:00.000Z',
    ]);
    expect(plan.missed).toBe(true);
    expect(new Date(plan.next!).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('walks forward from near the latest occurrences after a long downtime', () => {
    const plan = planOccurrences(
      { firesAt: at('2026-01-01T00:00:00Z'), cron: '* * * * * *', timezone: 'UTC', catchUp: 'all' },
      engine,
      { now: at('2026-01-08T00:00:00Z'), graceMs: 0, maxCatchUp: 3 }
    );
    expect(plan.fire.map((time) => new Date(time).toISOString())).toEqual([
      '2026-01-07T23:59:58.000Z',
      '2026-01-07T23:59:59.000Z',
      '2026-01-08T00:00:00.000Z',
    ]);
    expect(plan.missed).toBe(true);
  });

  const hourly = { cron: '0 * * * *', timezone: 'UTC', firesAt: at('2026-03-02T05:00:00Z') };
  const now = at('2026-03-02T09:30:00Z');

  it('latest fires the latest missed occurrence and goes on from the next', () => {
    const plan = planOccurrences(hourly, engine, { now, graceMs: 60_000 });
    expect(plan.fire).toEqual([at('2026-03-02T09:00:00Z')]);
    expect(plan.missed).toBe(true);
    expect(plan.next).toBe(at('2026-03-02T10:00:00Z'));
  });

  it('all fires every missed occurrence, oldest first, the latest maxCatchUp of them', () => {
    expect(
      planOccurrences({ ...hourly, catchUp: 'all' }, engine, { now, graceMs: 0 }).fire
    ).toEqual([
      at('2026-03-02T05:00:00Z'),
      at('2026-03-02T06:00:00Z'),
      at('2026-03-02T07:00:00Z'),
      at('2026-03-02T08:00:00Z'),
      at('2026-03-02T09:00:00Z'),
    ]);
    expect(
      planOccurrences({ ...hourly, catchUp: 'all' }, engine, { now, graceMs: 0, maxCatchUp: 2 })
        .fire
    ).toEqual([at('2026-03-02T08:00:00Z'), at('2026-03-02T09:00:00Z')]);
  });

  it('none fires only an occurrence due within the grace', () => {
    expect(
      planOccurrences({ ...hourly, catchUp: 'none' }, engine, { now, graceMs: 60_000 }).fire
    ).toEqual([]);
    const onTime = planOccurrences(
      { ...hourly, firesAt: at('2026-03-02T09:00:00Z'), catchUp: 'none' },
      engine,
      { now: at('2026-03-02T09:00:20Z'), graceMs: 60_000 }
    );
    expect(onTime.fire).toEqual([at('2026-03-02T09:00:00Z')]);
    expect(onTime.missed).toBe(false);
  });

  it('lets go of occurrences older than the window', () => {
    const plan = planOccurrences(
      { ...hourly, catchUp: 'all', catchUpWindowMs: 2 * 60 * 60 * 1000 },
      engine,
      { now, graceMs: 0 }
    );
    expect(plan.fire).toEqual([at('2026-03-02T08:00:00Z'), at('2026-03-02T09:00:00Z')]);
    const stale = planOccurrences(
      { ...hourly, firesAt: at('2026-02-01T00:00:00Z'), catchUpWindowMs: 60_000 },
      engine,
      { now: at('2026-03-02T09:30:00Z'), graceMs: 0 }
    );
    expect(stale.fire).toEqual([]);
    expect(stale.next).toBe(at('2026-03-02T10:00:00Z'));
  });

  it('plans intervals and one-shot entries', () => {
    const every = planOccurrences({ firesAt: 1_000, interval: 1_000 }, undefined, {
      now: 4_500,
      graceMs: 0,
    });
    expect(every.fire).toEqual([4_000]);
    expect(every.next).toBe(5_000);
    const once = planOccurrences({ firesAt: 1_000 }, undefined, { now: 9_000, graceMs: 0 });
    expect(once).toEqual({ fire: [1_000], missed: false, next: null });
  });
});
