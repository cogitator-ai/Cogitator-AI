/**
 * The one cron of the runtime: occurrences of an expression in a time zone, over `cron-parser`.
 * The scheduler, `getNextCronMs` of channels, the cron helpers of workflows and `schedule_task`
 * all compute through an engine built here, so a preset, a 6-field expression or a time zone
 * means the same everywhere
 */

import type { CronEngine } from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/** The part of `cron-parser`'s `CronExpressionParser` the engine uses */
export interface CronParserLike {
  parse(
    expression: string,
    options?: { currentDate?: Date; tz?: string }
  ): { next(): { getTime(): number }; prev(): { getTime(): number } };
}

/** Options of {@link experimental_createCronEngine} */
export interface CronEngineOptions {
  /**
   * Names that stand for an expression, matched without regard to case, on top of those
   * `cron-parser` knows itself (`@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`,
   * `@weekdays`, `@weekends` and the like)
   */
  presets?: Readonly<Record<string, string>>;
}

/** The most occurrences `between` returns unless asked for fewer */
export const DEFAULT_OCCURRENCE_LIMIT = 100;

/** Whether `timezone` is a time zone this process knows */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Experimental. A cron engine over `parser` (`CronExpressionParser` of `cron-parser`), with
 * `presets` on top of the parser's own. 5 fields are minute to day of week, 6 fields start with
 * the second. In a time zone with daylight saving an occurrence in the skipped hour fires at the
 * first minute after it, and one in the repeated hour fires once, the first time
 */
export function experimental_createCronEngine(
  parser: CronParserLike,
  options: CronEngineOptions = {}
): CronEngine {
  const presets = new Map(
    Object.entries(options.presets ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  const normalize = (expression: string): string => {
    const trimmed = expression.trim().replace(/\s+/g, ' ');
    return presets.get(trimmed.toLowerCase()) ?? trimmed;
  };
  const parse = (expression: string, from: number, timezone: string | undefined) =>
    parser.parse(normalize(expression), {
      currentDate: new Date(from),
      ...(timezone ? { tz: timezone } : {}),
    });
  return {
    normalize,
    next(expression, after, timezone) {
      return parse(expression, after, timezone).next().getTime();
    },
    previous(expression, atOrBefore, timezone, count = 1) {
      const found: number[] = [];
      if (count <= 0) return found;
      const iterator = parse(expression, atOrBefore + 1000, timezone);
      while (found.length < count) {
        let at: number;
        try {
          at = iterator.prev().getTime();
        } catch {
          break;
        }
        if (at <= atOrBefore) found.push(at);
      }
      return found;
    },
    between(expression, from, to, timezone, limit = DEFAULT_OCCURRENCE_LIMIT) {
      const found: number[] = [];
      if (to <= from || limit <= 0) return found;
      const iterator = parse(expression, from, timezone);
      while (found.length < limit) {
        let at: number;
        try {
          at = iterator.next().getTime();
        } catch {
          break;
        }
        if (at > to) break;
        found.push(at);
      }
      return found;
    },
    problem(expression, timezone) {
      if (typeof expression !== 'string' || expression.trim() === '') {
        return 'Invalid cron expression: it is empty';
      }
      if (timezone !== undefined && !isKnownTimezone(timezone)) {
        return `Unknown time zone: ${timezone}`;
      }
      const fields = normalize(expression).split(' ');
      if (!fields[0]?.startsWith('@') && (fields.length < 5 || fields.length > 6)) {
        return `Invalid cron expression "${expression}": it has ${fields.length} fields, cron takes 5 or 6`;
      }
      try {
        parse(expression, Date.now(), timezone).next();
        return undefined;
      } catch (error) {
        return `Invalid cron expression "${expression}": ${errorText(error)}`;
      }
    },
  };
}

let loaded: Promise<CronEngine> | undefined;

/**
 * Experimental. The cron engine over `cron-parser`, an optional peer dependency of the core,
 * imported on first use. The channels and workflows packages depend on it themselves.
 *
 * @throws CogitatorError `CONFIGURATION_ERROR` when `cron-parser` is not installed
 */
export function experimental_loadCronEngine(): Promise<CronEngine> {
  loaded ??= importCronParser().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
}

async function importCronParser(): Promise<CronEngine> {
  let module: unknown;
  try {
    module = await import('cron-parser');
  } catch (error) {
    throw new CogitatorError({
      message:
        'Cron schedules need the cron-parser package: npm install cron-parser (or pass a cron engine)',
      code: ErrorCode.CONFIGURATION_ERROR,
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
  const parser = parserOf(module);
  if (!parser) {
    throw new CogitatorError({
      message: 'cron-parser has no CronExpressionParser: install cron-parser 5 or newer',
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  }
  return experimental_createCronEngine(parser);
}

function parserOf(module: unknown): CronParserLike | undefined {
  const candidates = [module, (module as { default?: unknown } | null)?.default];
  for (const candidate of candidates) {
    const parser = (candidate as { CronExpressionParser?: unknown } | null | undefined)
      ?.CronExpressionParser;
    if (
      typeof parser === 'function' &&
      typeof (parser as { parse?: unknown }).parse === 'function'
    ) {
      return parser as unknown as CronParserLike;
    }
  }
  return undefined;
}

/** What a schedule fires when it is due: the occurrences to run and when it is due next */
export interface OccurrencePlan {
  /** The occurrences to fire now, oldest first: one, several (`all`) or none (all missed) */
  fire: number[];
  /** Whether occurrences were let go, because of `catchUp`, the window or the cap */
  missed: boolean;
  /** When the schedule is due next, null for a one-shot entry */
  next: number | null;
}

/** What a schedule entry is, for {@link planOccurrences} */
export interface PlannedSchedule {
  /** The occurrence the entry is due for */
  firesAt: number;
  cron?: string;
  timezone?: string;
  /** Repeats every `interval` ms */
  interval?: number;
  catchUp?: 'latest' | 'none' | 'all';
  /** Unset: no limit */
  catchUpWindowMs?: number;
}

/** Options of {@link planOccurrences} */
export interface PlanOptions {
  now: number;
  /** How late an occurrence may still fire with `catchUp: 'none'`, ms */
  graceMs: number;
  /** Most occurrences fired at once with `catchUp: 'all'` (default 100) */
  maxCatchUp?: number;
}

/** Longer than any daylight saving shift, so walking forward from before it misses nothing */
const SHIFT_MARGIN_MS = 3 * 60 * 60 * 1000;
/** Occurrences one step of the forward walk reads */
const WALK_STEP = 1000;

/**
 * The latest `count` occurrences after `after` up to and including `now`, newest first. They are
 * found walking forward with `between`, as the schedule fires them: walking back over a daylight
 * saving change would give an hour that repeats twice or a time that does not exist. The walk
 * starts a margin before the oldest of the latest `count`, not at `after`, so a long downtime
 * reads few occurrences
 */
function latestOccurrences(
  cron: CronEngine,
  expression: string,
  after: number,
  now: number,
  timezone: string | undefined,
  count: number
): number[] {
  let from = after;
  const previous = cron.previous(expression, now, timezone, count);
  const oldest = previous[previous.length - 1];
  if (previous.length === count && oldest !== undefined) {
    from = Math.max(from, oldest - SHIFT_MARGIN_MS);
  }
  const kept: number[] = [];
  for (;;) {
    const step = cron.between(expression, from, now, timezone, WALK_STEP);
    for (const at of step) {
      kept.push(at);
      if (kept.length > count) kept.shift();
    }
    const last = step[step.length - 1];
    if (step.length < WALK_STEP || last === undefined || last <= from) break;
    from = last;
  }
  return kept.reverse();
}

/**
 * Which occurrences of a due schedule fire now. The occurrences due are the entry's `firesAt` and
 * every later one up to `now`. Those older than `catchUpWindowMs` are let go, then `latest`
 * fires the latest of the rest, `all` fires each of them (the latest `maxCatchUp`, oldest first),
 * and `none` fires the latest occurrence only when it is no later than `graceMs`. The next time
 * is the first occurrence after `now`
 */
export function planOccurrences(
  schedule: PlannedSchedule,
  cron: CronEngine | undefined,
  options: PlanOptions
): OccurrencePlan {
  const { now, graceMs } = options;
  const maxCatchUp = Math.max(1, options.maxCatchUp ?? DEFAULT_OCCURRENCE_LIMIT);
  const mode = schedule.catchUp ?? 'latest';
  const wanted = mode === 'all' ? maxCatchUp + 1 : 2;
  let recent: number[] = [];
  let next: number | null = null;
  if (schedule.cron) {
    if (!cron) throw new Error('A cron schedule needs a cron engine');
    recent = latestOccurrences(
      cron,
      schedule.cron,
      schedule.firesAt,
      now,
      schedule.timezone,
      wanted
    );
    next = cron.next(schedule.cron, now, schedule.timezone);
  } else if (schedule.interval !== undefined && schedule.interval > 0) {
    const step = schedule.interval;
    const passed = Math.max(0, Math.floor((now - schedule.firesAt) / step));
    for (let k = passed; k > 0 && recent.length < wanted; k--) {
      recent.push(schedule.firesAt + k * step);
    }
    next = schedule.firesAt + (passed + 1) * step;
  }
  const due = [...recent, schedule.firesAt];
  const window = schedule.catchUpWindowMs;
  const inWindow = window === undefined ? due : due.filter((at) => now - at <= window);
  let fire: number[];
  if (mode === 'all') {
    fire = inWindow.slice(0, maxCatchUp).reverse();
  } else if (mode === 'none') {
    fire = inWindow[0] === due[0] && now - due[0] <= graceMs ? [due[0]] : [];
  } else {
    fire = inWindow.length > 0 ? [inWindow[0]] : [];
  }
  return { fire, missed: due.length > fire.length, next };
}
