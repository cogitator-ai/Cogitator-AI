import { describe, it, expect } from 'vitest';
import {
  parseCronExpression,
  validateCronExpression,
  getNextCronOccurrence,
  getPreviousCronOccurrence,
  getNextCronOccurrences,
  createCronIterator,
  cronMatchesDate,
  msUntilNextCronOccurrence,
} from '../timers/cron-parser';

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('cron-parser field introspection', () => {
  it('expands ranges, steps, aliases and the last-day marker', () => {
    const parsed = parseCronExpression('*/15 9-17 L jan,jun mon-fri');

    expect(parsed.hasSeconds).toBe(false);
    expect(parsed.fields).toEqual({
      second: undefined,
      minute: [0, 15, 30, 45],
      hour: [9, 10, 11, 12, 13, 14, 15, 16, 17],
      dayOfMonth: ['L'],
      month: [1, 6],
      dayOfWeek: [1, 2, 3, 4, 5],
    });
  });

  it('keeps wildcard day fields at their full length', () => {
    const { fields } = parseCronExpression('* * * * *');

    expect(fields.minute).toHaveLength(60);
    expect(fields.hour).toHaveLength(24);
    expect(fields.dayOfMonth).toHaveLength(31);
    expect(fields.month).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(fields.dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('normalizes Sunday written as 7', () => {
    expect(parseCronExpression('0 0 * * 7').fields.dayOfWeek).toEqual([0]);
  });

  it('exposes the seconds field only for six-field expressions', () => {
    const parsed = parseCronExpression('30 */10 * * * *');

    expect(parsed.hasSeconds).toBe(true);
    expect(parsed.fields.second).toEqual([30]);
    expect(parsed.fields.minute).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('resolves presets and keeps fields independent of the timezone', () => {
    const utc = parseCronExpression('@daily', 'UTC');
    const ny = parseCronExpression('@daily', 'America/New_York');

    expect(utc.expression).toBe('0 0 * * *');
    expect(ny.timezone).toBe('America/New_York');
    expect(ny.fields).toEqual(utc.fields);
  });

  it('returns copies that do not leak into later parses', () => {
    parseCronExpression('0 9 * * 1-5').fields.dayOfWeek.push(6);

    expect(parseCronExpression('0 9 * * 1-5').fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('cron-parser validation', () => {
  it.each(['invalid', 'not a cron', '60 * * * *', '0 0 31 2 *', '0 0 0 * * * *'])(
    'rejects %s with the parser error',
    (expression) => {
      const result = validateCronExpression(expression);

      expect(result.valid).toBe(false);
      expect(result.error).toEqual(expect.any(String));
      expect(result.error).not.toBe('');
      expect(result.normalized).toBeUndefined();
    }
  );

  it('accepts presets and reports the normalized expression', () => {
    expect(validateCronExpression('@WEEKDAYS')).toEqual({ valid: true, normalized: '0 0 * * 1-5' });
  });
});

describe('cron-parser scheduling', () => {
  it('maps the timezone option across DST spring-forward', () => {
    const next = getNextCronOccurrences('0 9 * * *', 3, {
      currentDate: new Date('2026-03-07T12:00:00Z'),
      timezone: 'America/New_York',
    });

    expect(iso(next)).toEqual([
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ]);
  });

  it('shifts a skipped wall-clock time forward on spring-forward day', () => {
    const next = getNextCronOccurrences('30 2 * * *', 3, {
      currentDate: new Date('2026-03-07T12:00:00Z'),
      timezone: 'America/New_York',
    });

    expect(iso(next)).toEqual([
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
      '2026-03-10T06:30:00.000Z',
    ]);
  });

  it('fires a repeated wall-clock time once on fall-back day', () => {
    const next = getNextCronOccurrences('30 1 * * *', 3, {
      currentDate: new Date('2026-10-31T12:00:00Z'),
      timezone: 'America/New_York',
    });

    expect(iso(next)).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
      '2026-11-03T06:30:00.000Z',
    ]);
  });

  it('handles fractional UTC offsets', () => {
    const next = getNextCronOccurrence('0 0 * * *', {
      currentDate: new Date('2026-01-01T00:00:00Z'),
      timezone: 'Asia/Kolkata',
    });

    expect(next.toISOString()).toBe('2026-01-01T18:30:00.000Z');
  });

  it('uses the local timezone when none is given', () => {
    const next = getNextCronOccurrence('0 9 * * *', {
      currentDate: new Date(2026, 0, 1, 10, 0, 0),
    });

    expect(next.getTime()).toBe(new Date(2026, 0, 2, 9, 0, 0).getTime());
  });

  it('iterates seconds, last-day and nth-weekday expressions', () => {
    const from = { currentDate: new Date('2026-01-01T10:00:05Z'), timezone: 'UTC' };

    expect(iso(getNextCronOccurrences('*/20 * * * * *', 3, from))).toEqual([
      '2026-01-01T10:00:20.000Z',
      '2026-01-01T10:00:40.000Z',
      '2026-01-01T10:01:00.000Z',
    ]);
    expect(
      iso(
        getNextCronOccurrences('0 0 L * *', 3, {
          currentDate: new Date('2026-02-01T00:00:00Z'),
          timezone: 'UTC',
        })
      )
    ).toEqual(['2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z']);
    expect(
      iso(
        getNextCronOccurrences('0 0 * * 1#2', 3, {
          currentDate: new Date('2026-01-01T00:00:00Z'),
          timezone: 'UTC',
        })
      )
    ).toEqual(['2026-01-12T00:00:00.000Z', '2026-02-09T00:00:00.000Z', '2026-03-09T00:00:00.000Z']);
  });

  it('walks backwards with the timezone applied', () => {
    const prev = getPreviousCronOccurrence('0 9 * * 1-5', {
      currentDate: new Date('2026-03-10T12:00:00Z'),
      timezone: 'America/New_York',
    });

    expect(prev.toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('computes the delay until the next run', () => {
    const ms = msUntilNextCronOccurrence('*/15 * * * *', {
      currentDate: new Date('2026-01-01T10:07:00Z'),
      timezone: 'UTC',
    });

    expect(ms).toBe(8 * 60_000);
  });
});

describe('cron-parser time span bounds', () => {
  const bounds = {
    currentDate: new Date('2026-01-01T00:30:00Z'),
    startDate: new Date('2025-12-31T23:00:00Z'),
    endDate: new Date('2026-01-01T02:00:00Z'),
    timezone: 'UTC',
  };

  it('stops collecting occurrences at the end date', () => {
    expect(iso(getNextCronOccurrences('0 * * * *', 5, bounds))).toEqual([
      '2026-01-01T01:00:00.000Z',
      '2026-01-01T02:00:00.000Z',
    ]);
  });

  it('throws when the next occurrence is past the end date', () => {
    expect(() =>
      getNextCronOccurrence('0 * * * *', {
        ...bounds,
        currentDate: new Date('2026-01-01T02:00:00Z'),
      })
    ).toThrow();
  });

  it('lets the iterator report exhaustion in both directions', () => {
    const iterator = createCronIterator('0 * * * *', bounds);

    expect(iterator.hasNext()).toBe(true);
    expect(iterator.hasPrev()).toBe(true);
    expect(iterator.next()?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(iterator.next()?.toISOString()).toBe('2026-01-01T02:00:00.000Z');
    expect(iterator.hasNext()).toBe(false);
    expect(iterator.next()).toBeNull();

    iterator.reset(new Date('2026-01-01T00:30:00Z'));
    expect(iterator.prev()?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(iterator.prev()?.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(iterator.hasPrev()).toBe(false);
    expect(iterator.prev()).toBeNull();
  });
});

describe('cronMatchesDate', () => {
  it('evaluates parsed fields in the requested timezone', () => {
    const date = new Date('2026-03-09T13:00:00Z');

    expect(cronMatchesDate('0 9 * * 1-5', date, 'America/New_York')).toBe(true);
    expect(cronMatchesDate('0 9 * * 0,6', date, 'America/New_York')).toBe(false);
    expect(cronMatchesDate('0 9 * * *', date, 'UTC')).toBe(false);
  });

  it('applies OR semantics when both day fields are restricted', () => {
    expect(cronMatchesDate('0 0 15 * 1', new Date('2026-03-09T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronMatchesDate('0 0 15 * 1', new Date('2026-03-15T00:00:00Z'), 'UTC')).toBe(true);
    expect(cronMatchesDate('0 0 15 * 1', new Date('2026-03-10T00:00:00Z'), 'UTC')).toBe(false);
  });
});
