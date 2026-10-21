import { describe, it, expect } from 'vitest';
import { resolveTime, type TimeExpression } from '../time-resolution';

const session = new Date('2026-01-07T12:00:00Z');

function resolved(expression: Omit<TimeExpression, 'text'>, timeZone?: string, at = session) {
  const time = resolveTime({ text: 'words', ...expression }, at, timeZone);
  return [time.start?.toISOString(), time.end?.toISOString(), time.precision];
}

describe('resolveTime', () => {
  it('shifts days, weeks, months and years from the session date', () => {
    expect(resolved({ relative: { unit: 'day', amount: -1 } })).toEqual([
      '2026-01-06T00:00:00.000Z',
      '2026-01-07T00:00:00.000Z',
      'day',
    ]);
    expect(resolved({ relative: { unit: 'week', amount: -1 } })).toEqual([
      '2025-12-29T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
      'week',
    ]);
    expect(resolved({ relative: { unit: 'month', amount: 1 } })).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      'month',
    ]);
    expect(resolved({ relative: { unit: 'month', amount: -1 } })[0]).toBe(
      '2025-12-01T00:00:00.000Z'
    );
    expect(resolved({ relative: { unit: 'year', amount: -1 } })).toEqual([
      '2025-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'year',
    ]);
  });

  it('finds the last, this and next weekday of a Wednesday', () => {
    const day = (weekday: TimeExpression['weekday']) => resolved({ weekday })[0]?.slice(0, 10);
    expect(day({ day: 'friday', amount: -1 })).toBe('2026-01-02');
    expect(day({ day: 'wednesday', amount: -1 })).toBe('2025-12-31');
    expect(day({ day: 'friday', amount: 0 })).toBe('2026-01-09');
    expect(day({ day: 'monday', amount: 1 })).toBe('2026-01-12');
    expect(day({ day: 'monday', amount: 2 })).toBe('2026-01-19');
    expect(day({ day: 'friday', amount: -2 })).toBe('2025-12-26');
  });

  it('reads dates as given, with their precision, and prefers them to a shift', () => {
    expect(resolved({ date: '2024' })).toEqual([
      '2024-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      'year',
    ]);
    expect(resolved({ date: '2024-05' })[2]).toBe('month');
    expect(resolved({ date: '2024-02-29', relative: { unit: 'day', amount: -1 } })).toEqual([
      '2024-02-29T00:00:00.000Z',
      '2024-03-01T00:00:00.000Z',
      'day',
    ]);
    expect(resolved({ date: '2024-05-03T14:30' }, 'Europe/Lisbon')).toEqual([
      '2024-05-03T13:30:00.000Z',
      '2024-05-03T13:30:00.000Z',
      'instant',
    ]);
  });

  it('works out the calendar in the time zone of the session', () => {
    const lateEvening = new Date('2026-01-07T23:30:00Z');
    expect(resolved({ relative: { unit: 'day', amount: -1 } }, 'Asia/Tokyo', lateEvening)).toEqual([
      '2026-01-06T15:00:00.000Z',
      '2026-01-07T15:00:00.000Z',
      'day',
    ]);
    expect(resolved({ date: '2026-03-08' }, 'America/New_York')).toEqual([
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
      'day',
    ]);
  });

  it('keeps only the words of a time it cannot work out', () => {
    expect(resolveTime({ text: 'back in the day', date: '2024-13' }, session)).toEqual({
      text: 'back in the day',
      precision: 'approximate',
    });
  });
});
