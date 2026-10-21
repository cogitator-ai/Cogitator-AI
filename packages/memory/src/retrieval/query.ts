/**
 * What a turn asks of memory, read from its words without a model: whether to search at all,
 * what kind of question it is, and the time it names
 */

import type { MemoryItemTime } from '@cogitator-ai/types';
import { tokenize } from '../search/tokenizer';
import { calendarDate, resolveTime, type TimeExpression, type Weekday } from '../time-resolution';

/**
 * The kind of question a turn asks, which decides how the channels of a search weigh: about a
 * time (`temporal`), about how things stand now (`update`), about many things at once
 * (`aggregate`), about what someone likes (`preference`), or anything else (`general`)
 */
export type QueryType = 'temporal' | 'update' | 'aggregate' | 'preference' | 'general';

export interface QueryAnalysis {
  /** Whether memory is worth searching for the turn: not for a greeting or a thanks */
  retrieve: boolean;
  type: QueryType;
  /** The time the turn names, resolved from the anchor date, when it names one */
  time?: MemoryItemTime;
  /** The words of the turn that carry meaning */
  terms: string[];
}

const SMALL_TALK =
  /^(?:ok(?:ay)?|k|thanks?(?: you)?(?: (?:so|very) much)?|thx|ty|got it|cool|great|nice|perfect|awesome|sounds good|yes|yeah|yep|no|nope|sure|alright|hi|hello|hey|bye|good(?: night| morning)?|lol|haha)[\s.!?)]*$/i;

const TEMPORAL =
  /\b(?:when|what (?:date|day|time|year|month)|how long|how many (?:days|weeks|months|years)|before|after|first|last|earlier|later|ago|since|until|yesterday|today|tomorrow|tonight|recently|previous(?:ly)?|order)\b/i;
const UPDATE =
  /\b(?:now|currently|current|still|anymore|any more|latest|most recent|changed?|moved|switched|new|these days|nowadays|at the moment)\b/i;
const AGGREGATE =
  /\b(?:how many|how much|in total|total|all (?:the|of|my)|list|count|every|each|altogether|combined|sum)\b/i;
const PREFERENCE =
  /\b(?:recommend|suggest|suggestions?|prefer(?:ence|red)?|favou?rite|should i|what kind|ideas? for|tips?|would i (?:like|enjoy)|any advice)\b/i;

const WEEKDAYS: Weekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const UNIT = '(day|week|month|year)s?';

/**
 * The time words of `text` as a {@link TimeExpression}, the first that can be placed. A date
 * without a year (`March 9`, `in May`) is the last such date up to `today`, the date the
 * question is asked on, so `in May` asked in March is the May before.
 */
export function timeExpressionOf(
  text: string,
  today?: { year: number; month: number; day: number }
): TimeExpression | undefined {
  const lower = text.toLowerCase();
  const match = (pattern: RegExp) => pattern.exec(lower);

  if (match(/\byesterday\b/)) return { text: 'yesterday', relative: { unit: 'day', amount: -1 } };
  if (match(/\btoday\b|\btonight\b/))
    return { text: 'today', relative: { unit: 'day', amount: 0 } };
  if (match(/\btomorrow\b/)) return { text: 'tomorrow', relative: { unit: 'day', amount: 1 } };

  const ago = match(new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join('|')}) ${UNIT} ago\\b`));
  if (ago) {
    const amount = Number(ago[1]) || NUMBER_WORDS[ago[1] ?? ''] || 1;
    return {
      text: ago[0],
      relative: { unit: ago[2] as 'day' | 'week' | 'month' | 'year', amount: -amount },
    };
  }

  const shifted = match(new RegExp(`\\b(last|this|next) ${UNIT}\\b`));
  if (shifted) {
    const amount = shifted[1] === 'last' ? -1 : shifted[1] === 'next' ? 1 : 0;
    return {
      text: shifted[0],
      relative: { unit: shifted[2] as 'day' | 'week' | 'month' | 'year', amount },
    };
  }

  const weekday = match(new RegExp(`\\b(last|this|next|on) (${WEEKDAYS.join('|')})\\b`));
  if (weekday) {
    const amount = weekday[1] === 'next' ? 1 : weekday[1] === 'this' ? 0 : -1;
    return { text: weekday[0], weekday: { day: weekday[2] as Weekday, amount } };
  }

  const months = MONTHS.join('|');
  const dayFirst = match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${months})(?:,? (\\d{4}))?\\b`)
  );
  const monthFirst = match(
    new RegExp(`\\b(${months}) (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`)
  );
  const day = dayFirst
    ? { text: dayFirst[0], day: dayFirst[1], month: dayFirst[2], year: dayFirst[3] }
    : monthFirst
      ? { text: monthFirst[0], day: monthFirst[2], month: monthFirst[1], year: monthFirst[3] }
      : undefined;
  const inYear = (given: string | undefined, month: number, onDay = 1) => {
    if (given !== undefined) return given;
    if (!today) return undefined;
    const ahead = month > today.month || (month === today.month && onDay > today.day);
    return String(ahead ? today.year - 1 : today.year);
  };
  if (day) {
    const month = MONTHS.indexOf(day.month ?? '') + 1;
    const dayYear = inYear(day.year, month, Number(day.day));
    if (dayYear && month > 0) {
      return {
        text: day.text,
        date: `${dayYear}-${String(month).padStart(2, '0')}-${String(Number(day.day)).padStart(2, '0')}`,
      };
    }
  }

  const monthYear = match(new RegExp(`\\b(${months})(?:,? (\\d{4}))?\\b`));
  const yearOnly = match(/\b(19\d{2}|20\d{2})\b/);
  if (monthYear) {
    const month = MONTHS.indexOf(monthYear[1] ?? '') + 1;
    const monthsYear = monthYear[2] ?? yearOnly?.[1] ?? inYear(undefined, month);
    if (monthsYear) {
      return { text: monthYear[0], date: `${monthsYear}-${String(month).padStart(2, '0')}` };
    }
  }
  if (yearOnly) return { text: yearOnly[0], date: yearOnly[1] ?? '' };
  return undefined;
}

/**
 * What `input` asks of memory, with the time it names resolved from `anchor` (the date the turn is
 * asked on) in `timeZone`. Greetings, thanks and one-word replies are not worth a search.
 */
export function analyzeQuery(input: string, anchor: Date, timeZone = 'UTC'): QueryAnalysis {
  const text = input.trim();
  const terms = tokenize(text);
  if (text.length === 0 || SMALL_TALK.test(text) || terms.length === 0) {
    return { retrieve: false, type: 'general', terms };
  }
  const expression = timeExpressionOf(text, calendarDate(anchor, timeZone));
  const time = expression ? resolveTime(expression, anchor, timeZone) : undefined;
  const type: QueryType = TEMPORAL.test(text)
    ? 'temporal'
    : AGGREGATE.test(text)
      ? 'aggregate'
      : UPDATE.test(text)
        ? 'update'
        : PREFERENCE.test(text)
          ? 'preference'
          : time?.start
            ? 'temporal'
            : 'general';
  return { retrieve: true, type, ...(time?.start && { time }), terms };
}
