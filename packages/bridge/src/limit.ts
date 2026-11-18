import { oneLine } from './letters.js';

/** What a harness said when it ran into the limit of its subscription or its key. */
export interface LimitSignal {
  /** Ms since the epoch the limit is said to be over at, when the harness told */
  until?: number;
  /** What the harness said, on one line */
  detail: string;
}

/** How much of what a harness said is kept. */
const DETAIL_LENGTH = 300;

/** How much of a text is looked at for the words of a limit. */
const LOOKED_AT = 4_000;

/** The furthest a reset may lie ahead to be believed: a monthly cap resets within this. */
const MAX_AHEAD_MS = 32 * 86_400_000;

/** How many characters after a marker such as `resets` are read for a time. */
const SAID = 48;

/** How long ago a time of day may have passed to count as now and not as tomorrow. */
const JUST_PASSED_MS = 15 * 60_000;

/**
 * The words harnesses and model providers use for a limit that is used up. They are looked for
 * in what a harness says of a failed call to its model, never in what an agent wrote or a tool
 * printed, so a job about a rate limiter, a full disk quota or the rate limit of some other
 * service is not taken for one.
 */
const LIMIT_WORDS: readonly RegExp[] = [
  /hit your [a-z0-9' ]{0,40}limit/i,
  /usage limit/i,
  /rate limit/i,
  /spend limit/i,
  /too many requests/i,
  /credit balance is too low/i,
  /insufficient_quota/i,
  /exceeded your current quota/i,
];

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Clock {
  hours: number;
  minutes: number;
}

/** A time of day at the start of a text: `3:07 PM`, `3pm`, `15:07`. */
function clockAt(text: string): Clock | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![a-z0-9])/i.exec(text);
  if (!match) return undefined;
  const half = match[3]?.toLowerCase();
  if (half === undefined && match[2] === undefined) return undefined;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  if (half !== undefined) {
    if (hours < 1 || hours > 12) return undefined;
    hours = (hours % 12) + (half === 'pm' ? 12 : 0);
  }
  return hours > 23 || minutes > 59 ? undefined : { hours, minutes };
}

/**
 * The next time the clock of this machine shows `clock`, after `now`. A time that passed within
 * the last quarter of an hour is no time ahead at all: the harness named it just before, and
 * the limit is as good as over, not a day away.
 */
function nextAt(clock: Clock, now: number): number | undefined {
  const at = new Date(now);
  at.setHours(clock.hours, clock.minutes, 0, 0);
  if (at.getTime() > now) return at.getTime();
  if (now - at.getTime() < JUST_PASSED_MS) return undefined;
  at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** A stretch of time ahead at the start of a text: `4 hours`, `4h 30m`, `90 seconds`. */
function stretchAt(text: string): number | undefined {
  let rest = text;
  let total = 0;
  for (let parts = 0; parts < 3; parts += 1) {
    const match = /^(\d{1,5})\s*(s|m|h|d)[a-z]{0,6}\.?,?\s*(?:and\s+)?/i.exec(rest);
    if (!match) break;
    total += Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
    rest = rest.slice(match[0].length);
  }
  return total > 0 ? total : undefined;
}

/** When the words after a marker say a limit is over, undefined when they name no time. */
function momentOf(said: string, now: number): number | undefined {
  const day = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6},?\s+/i.exec(said);
  const date = /^([a-z]{3})[a-z]{0,6}\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?\s*/i.exec(
    said
  );
  if (day) {
    const clock = clockAt(said.slice(day[0].length));
    if (!clock) return undefined;
    const wanted = DAYS.indexOf(day[1].toLowerCase());
    const at = new Date(now);
    at.setHours(clock.hours, clock.minutes, 0, 0);
    for (let ahead = 0; ahead <= 7; ahead += 1) {
      if (at.getDay() === wanted && at.getTime() > now) break;
      at.setDate(at.getDate() + 1);
    }
    return at.getTime();
  }
  if (date && MONTHS.includes(date[1].toLowerCase())) {
    const month = MONTHS.indexOf(date[1].toLowerCase());
    const dayOfMonth = Number(date[2]);
    const clock = clockAt(said.slice(date[0].length));
    const at = (year: number): number =>
      clock
        ? new Date(year, month, dayOfMonth, clock.hours, clock.minutes).getTime()
        : Date.UTC(year, month, dayOfMonth);
    const year = date[3] === undefined ? new Date(now).getFullYear() : Number(date[3]);
    const until = at(year);
    return date[3] === undefined && until <= now ? at(year + 1) : until;
  }
  const clock = clockAt(said);
  return clock ? nextAt(clock, now) : undefined;
}

/**
 * When a limit is over, read from the words that follow `try again at`, `resets` or `try again
 * in`: a time of day (`3:07 PM`, the next time the clock of this machine shows it), a day of the
 * week and a time (`Mon 12:00am`), a date with or without a year and a time
 * (`Nov 18th, 2026 3:07 PM`, `Dec 1`), or a stretch of time (`in 4 hours`). Harnesses show
 * these in the time of the machine they run on. A date without a time is midnight UTC, which is
 * when spend caps reset. Undefined when the text names no time, or one that is past or further
 * ahead than a limit lasts.
 */
export function limitResetOf(text: string, now: number): number | undefined {
  const ahead = /\b(?:try again|retry|resets?) in\s+/i.exec(text);
  const stretch = ahead
    ? stretchAt(text.slice(ahead.index + ahead[0].length, ahead.index + ahead[0].length + SAID))
    : undefined;
  const moments = [...text.matchAll(/\b(?:try again at|resets?(?: at| on)?)\s+/gi)].map((marker) =>
    text.slice(marker.index + marker[0].length, marker.index + marker[0].length + SAID).trim()
  );
  const candidates = [
    ...(stretch === undefined ? [] : [now + stretch]),
    ...moments.map((said) => momentOf(said, now)),
  ];
  return candidates.find(
    (until): until is number =>
      until !== undefined && !Number.isNaN(until) && until > now && until - now <= MAX_AHEAD_MS
  );
}

/**
 * Reads the limit a harness ran into from what it said went wrong: `You've hit your usage
 * limit. Try again at 3:07 PM.` of Codex, `You've hit your session limit · resets 3:45pm` of
 * Claude Code, a `429 Too Many Requests` or an exhausted quota of a model provider. Undefined
 * for a text that names no limit.
 *
 * @param text what the harness said of the failure, not what an agent wrote
 * @param now ms since the epoch, to turn a time of day into a moment
 */
export function limitOf(text: string, now: number): LimitSignal | undefined {
  const said = text.slice(0, LOOKED_AT).replaceAll('’', "'");
  if (!LIMIT_WORDS.some((words) => words.test(said))) return undefined;
  const until = limitResetOf(said, now);
  return {
    ...(until !== undefined && { until }),
    detail: oneLine(said).slice(0, DETAIL_LENGTH),
  };
}

/** The error codes of the Cogitator runtime for a provider that takes no more requests. */
const LIMIT_CODES: ReadonlySet<string> = new Set(['LLM_RATE_LIMITED', 'LLM_QUOTA_EXCEEDED']);

/**
 * Reads a limit from what a turn of a hosted agent failed with: an error of the Cogitator
 * runtime that says the provider is rate limited or its quota is used up, with the wait the
 * provider named when it named one. Any other error is no limit, whatever its words: a turn
 * fails with what tools and other services said too, and those name limits of their own.
 */
export function limitOfError(error: unknown, now: number): LimitSignal | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, retryAfter, message } = error as {
    code?: unknown;
    retryAfter?: unknown;
    message?: unknown;
  };
  if (typeof code !== 'string' || !LIMIT_CODES.has(code)) return undefined;
  const wait =
    typeof retryAfter === 'number' && retryAfter > 0 && retryAfter <= MAX_AHEAD_MS
      ? retryAfter
      : undefined;
  return {
    ...(wait !== undefined && { until: now + wait }),
    detail: oneLine(typeof message === 'string' ? message : '').slice(0, DETAIL_LENGTH) || code,
  };
}

/** A moment as a person reads it on this machine: `15:07`, or `Nov 20 15:07` on another day. */
export function limitClock(until: number, now: number): string {
  const at = new Date(until);
  const two = (value: number): string => String(value).padStart(2, '0');
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return time;
  const month = MONTHS[at.getMonth()];
  return `${month[0].toUpperCase()}${month.slice(1)} ${at.getDate()} ${time}`;
}
