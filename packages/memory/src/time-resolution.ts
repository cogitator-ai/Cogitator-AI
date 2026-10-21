/**
 * Dates as said, resolved into intervals: a model marks up the words, the code does the calendar
 */

import type { MemoryItemTime, TimePrecision } from '@cogitator-ai/types';

export type Weekday =
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

/** The time words of a statement, as a model marks them up */
export interface TimeExpression {
  /** The words, such as `last Friday` */
  text: string;
  /** A date the words give, `YYYY`, `YYYY-MM`, `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` */
  date?: string;
  /** A shift from the session's date, such as `{ unit: 'day', amount: -3 }` for `3 days ago` */
  relative?: { unit: 'day' | 'week' | 'month' | 'year'; amount: number };
  /**
   * A weekday from the session's date: `amount` -1 the last one before it, 1 the next one
   * after it, 0 the one of its week
   */
  weekday?: { day: Weekday; amount: number };
}

const WEEKDAYS: Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const parts = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = parts.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    parts.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock of `instant` in `timeZone`, as if it were UTC */
function wallClock(instant: Date, timeZone: string): number {
  const fields = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second
  );
}

/** The instant the wall clock of `timeZone` shows the given time */
function zoned(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const first = wanted - (wallClock(new Date(wanted), timeZone) - wanted);
  const settled = wanted - (wallClock(new Date(first), timeZone) - first);
  return new Date(settled);
}

/** The calendar date of `instant` in `timeZone` */
export function calendarDate(instant: Date, timeZone: string): CalendarDate {
  const clock = new Date(wallClock(instant, timeZone));
  return { year: clock.getUTCFullYear(), month: clock.getUTCMonth() + 1, day: clock.getUTCDate() };
}

function shifted(date: CalendarDate, days: number): CalendarDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** 0 for Monday to 6 for Sunday */
function weekdayOf(date: CalendarDate): number {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

function dayInterval(date: CalendarDate, timeZone: string): Pick<MemoryItemTime, 'start' | 'end'> {
  const next = shifted(date, 1);
  return {
    start: zoned(timeZone, date.year, date.month, date.day),
    end: zoned(timeZone, next.year, next.month, next.day),
  };
}

function interval(
  unit: 'day' | 'week' | 'month' | 'year',
  date: CalendarDate,
  timeZone: string
): Pick<MemoryItemTime, 'start' | 'end'> {
  switch (unit) {
    case 'day':
      return dayInterval(date, timeZone);
    case 'week': {
      const monday = shifted(date, -weekdayOf(date));
      const next = shifted(monday, 7);
      return {
        start: zoned(timeZone, monday.year, monday.month, monday.day),
        end: zoned(timeZone, next.year, next.month, next.day),
      };
    }
    case 'month': {
      const nextYear = date.month === 12 ? date.year + 1 : date.year;
      const nextMonth = date.month === 12 ? 1 : date.month + 1;
      return {
        start: zoned(timeZone, date.year, date.month, 1),
        end: zoned(timeZone, nextYear, nextMonth, 1),
      };
    }
    case 'year':
      return { start: zoned(timeZone, date.year, 1, 1), end: zoned(timeZone, date.year + 1, 1, 1) };
  }
}

const DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2}))?)?)?$/;

function absolute(text: string, timeZone: string): Omit<MemoryItemTime, 'text'> | undefined {
  const match = DATE.exec(text.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match.map((part) =>
    part === undefined ? undefined : Number(part)
  );
  if (year === undefined) return undefined;
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined && month !== undefined) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > last) return undefined;
  }
  if (hour !== undefined && minute !== undefined && month !== undefined && day !== undefined) {
    if (hour > 23 || minute > 59) return undefined;
    const instant = zoned(timeZone, year, month, day, hour, minute);
    return { start: instant, end: instant, precision: 'instant' };
  }
  if (day !== undefined && month !== undefined) {
    return { ...interval('day', { year, month, day }, timeZone), precision: 'day' };
  }
  if (month !== undefined) {
    return { ...interval('month', { year, month, day: 1 }, timeZone), precision: 'month' };
  }
  return { ...interval('year', { year, month: 1, day: 1 }, timeZone), precision: 'year' };
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const index = date.year * 12 + (date.month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1, day: 1 };
}

/**
 * The interval `expression` names, from `sessionAt` in `timeZone` (an IANA name, UTC by
 * default): `start` inclusive, `end` exclusive, with the precision the words have. A date the
 * words give wins over a shift. Words that name no date the code can work out keep only their
 * text, with precision `approximate`.
 */
export function resolveTime(
  expression: TimeExpression,
  sessionAt: Date,
  timeZone = 'UTC'
): MemoryItemTime {
  const text = expression.text.trim();
  const withText = (time: Omit<MemoryItemTime, 'text'>): MemoryItemTime => ({
    ...(text && { text }),
    ...time,
  });
  if (expression.date) {
    const given = absolute(expression.date, timeZone);
    if (given) return withText(given);
  }
  const today = calendarDate(sessionAt, timeZone);
  if (expression.relative && Number.isFinite(expression.relative.amount)) {
    const { unit } = expression.relative;
    const amount = Math.trunc(expression.relative.amount);
    const precision: TimePrecision = unit;
    switch (unit) {
      case 'day':
        return withText({ ...interval('day', shifted(today, amount), timeZone), precision });
      case 'week':
        return withText({ ...interval('week', shifted(today, amount * 7), timeZone), precision });
      case 'month':
        return withText({ ...interval('month', addMonths(today, amount), timeZone), precision });
      case 'year':
        return withText({
          ...interval('year', { year: today.year + amount, month: 1, day: 1 }, timeZone),
          precision,
        });
    }
  }
  if (expression.weekday && WEEKDAYS.includes(expression.weekday.day)) {
    const target = WEEKDAYS.indexOf(expression.weekday.day);
    const current = weekdayOf(today);
    const amount = Math.trunc(expression.weekday.amount);
    let offset: number;
    if (amount === 0) offset = target - current;
    else if (amount < 0) offset = -((current - target + 7) % 7 || 7) + (amount + 1) * 7;
    else offset = ((target - current + 7) % 7 || 7) + (amount - 1) * 7;
    return withText({ ...interval('day', shifted(today, offset), timeZone), precision: 'day' });
  }
  return withText({ precision: 'approximate' });
}
