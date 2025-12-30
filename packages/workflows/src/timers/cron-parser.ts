/**
 * Cron expression parser with timezone support
 *
 * Features:
 * - Standard cron expression parsing (5 or 6 fields)
 * - Timezone-aware scheduling
 * - Human-readable descriptions
 * - Next/previous occurrence calculation
 * - Validation and error reporting
 */

import parser from 'cron-parser';

/**
 * Cron field descriptor
 */
interface CronField {
  name: string;
  min: number;
  max: number;
  aliases?: Record<string, number>;
}

const CRON_FIELDS: CronField[] = [
  { name: 'second', min: 0, max: 59 },
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  {
    name: 'month',
    min: 1,
    max: 12,
    aliases: {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    },
  },
  {
    name: 'dayOfWeek',
    min: 0,
    max: 7,
    aliases: {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    },
  },
];

/**
 * Common cron presets
 */
export const CRON_PRESETS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@every_minute': '* * * * *',
  '@every_5_minutes': '*/5 * * * *',
  '@every_15_minutes': '*/15 * * * *',
  '@every_30_minutes': '*/30 * * * *',
  '@weekdays': '0 0 * * 1-5',
  '@weekends': '0 0 * * 0,6',
};

/**
 * Parsed cron expression result
 */
export interface ParsedCron {
  expression: string;
  fields: {
    second?: number[];
    minute: number[];
    hour: number[];
    dayOfMonth: number[];
    month: number[];
    dayOfWeek: number[];
  };
  hasSeconds: boolean;
  timezone?: string;
}

/**
 * Cron iterator options
 */
export interface CronIteratorOptions {
  currentDate?: Date;
  startDate?: Date;
  endDate?: Date;
  timezone?: string;
  iterator?: boolean;
}

/**
 * Validate a cron expression
 */
export function validateCronExpression(expression: string): {
  valid: boolean;
  error?: string;
  normalized?: string;
} {
  // Handle presets
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;

  try {
    parser.parseExpression(normalized);
    return { valid: true, normalized };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron expression',
    };
  }
}

/**
 * Parse a cron expression
 */
export function parseCronExpression(
  expression: string,
  timezone?: string
): ParsedCron {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;
  const parts = normalized.trim().split(/\s+/);

  // Determine if expression has seconds field (6 parts)
  const hasSeconds = parts.length === 6;

  const options: CronIteratorOptions = {};
  if (timezone) {
    options.timezone = timezone;
  }

  const interval = parser.parseExpression(normalized, options);
  const fields = interval.fields;

  return {
    expression: normalized,
    fields: {
      second: hasSeconds ? Array.from(fields.second) as number[] : undefined,
      minute: Array.from(fields.minute) as number[],
      hour: Array.from(fields.hour) as number[],
      dayOfMonth: Array.from(fields.dayOfMonth) as number[],
      month: Array.from(fields.month) as number[],
      dayOfWeek: Array.from(fields.dayOfWeek) as number[],
    },
    hasSeconds,
    timezone,
  };
}

/**
 * Get the next occurrence of a cron expression
 */
export function getNextCronOccurrence(
  expression: string,
  options: CronIteratorOptions = {}
): Date {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;

  const interval = parser.parseExpression(normalized, {
    currentDate: options.currentDate ?? new Date(),
    startDate: options.startDate,
    endDate: options.endDate,
    tz: options.timezone,
  });

  return interval.next().toDate();
}

/**
 * Get the previous occurrence of a cron expression
 */
export function getPreviousCronOccurrence(
  expression: string,
  options: CronIteratorOptions = {}
): Date {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;

  const interval = parser.parseExpression(normalized, {
    currentDate: options.currentDate ?? new Date(),
    startDate: options.startDate,
    endDate: options.endDate,
    tz: options.timezone,
  });

  return interval.prev().toDate();
}

/**
 * Get next N occurrences of a cron expression
 */
export function getNextCronOccurrences(
  expression: string,
  count: number,
  options: CronIteratorOptions = {}
): Date[] {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;
  const occurrences: Date[] = [];

  const interval = parser.parseExpression(normalized, {
    currentDate: options.currentDate ?? new Date(),
    startDate: options.startDate,
    endDate: options.endDate,
    tz: options.timezone,
  });

  for (let i = 0; i < count; i++) {
    try {
      occurrences.push(interval.next().toDate());
    } catch {
      // No more occurrences within range
      break;
    }
  }

  return occurrences;
}

/**
 * Check if a cron expression matches a given date
 */
export function cronMatchesDate(
  expression: string,
  date: Date,
  timezone?: string
): boolean {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;

  // Get the date adjusted for timezone if needed
  let checkDate = date;
  if (timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) =>
      parseInt(parts.find((p) => p.type === type)?.value ?? '0');

    checkDate = new Date(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second')
    );
  }

  const parsed = parseCronExpression(normalized, timezone);

  // Check each field
  const minute = checkDate.getMinutes();
  const hour = checkDate.getHours();
  const dayOfMonth = checkDate.getDate();
  const month = checkDate.getMonth() + 1;
  const dayOfWeek = checkDate.getDay();

  if (!parsed.fields.minute.includes(minute)) return false;
  if (!parsed.fields.hour.includes(hour)) return false;
  if (!parsed.fields.month.includes(month)) return false;

  // Day matching is special: either dayOfMonth OR dayOfWeek must match
  // unless both are explicitly specified (not *)
  const dayOfMonthSpecified = parsed.fields.dayOfMonth.length < 31;
  const dayOfWeekSpecified = parsed.fields.dayOfWeek.length < 8;

  if (dayOfMonthSpecified && dayOfWeekSpecified) {
    // Both specified: either must match
    if (
      !parsed.fields.dayOfMonth.includes(dayOfMonth) &&
      !parsed.fields.dayOfWeek.includes(dayOfWeek)
    ) {
      return false;
    }
  } else if (dayOfMonthSpecified) {
    if (!parsed.fields.dayOfMonth.includes(dayOfMonth)) return false;
  } else if (dayOfWeekSpecified) {
    if (!parsed.fields.dayOfWeek.includes(dayOfWeek)) return false;
  }

  // Check seconds if specified
  if (parsed.hasSeconds && parsed.fields.second) {
    const second = checkDate.getSeconds();
    if (!parsed.fields.second.includes(second)) return false;
  }

  return true;
}

/**
 * Calculate milliseconds until next occurrence
 */
export function msUntilNextCronOccurrence(
  expression: string,
  options: CronIteratorOptions = {}
): number {
  const now = options.currentDate ?? new Date();
  const next = getNextCronOccurrence(expression, options);
  return next.getTime() - now.getTime();
}

/**
 * Get human-readable description of a cron expression
 */
export function describeCronExpression(expression: string): string {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;
  const parts = normalized.trim().split(/\s+/);

  // Handle preset descriptions
  const presetDescriptions: Record<string, string> = {
    '0 0 1 1 *': 'At midnight on January 1st',
    '0 0 1 * *': 'At midnight on the first day of each month',
    '0 0 * * 0': 'At midnight every Sunday',
    '0 0 * * *': 'At midnight every day',
    '0 * * * *': 'At the start of every hour',
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 0 * * 1-5': 'At midnight on weekdays',
    '0 0 * * 0,6': 'At midnight on weekends',
  };

  if (presetDescriptions[normalized]) {
    return presetDescriptions[normalized];
  }

  // Build description from parts
  const hasSeconds = parts.length === 6;
  const offset = hasSeconds ? 1 : 0;

  const minute = parts[0 + offset];
  const hour = parts[1 + offset];
  const dayOfMonth = parts[2 + offset];
  const month = parts[3 + offset];
  const dayOfWeek = parts[4 + offset];

  const descriptions: string[] = [];

  // Time description
  if (minute === '*' && hour === '*') {
    descriptions.push('Every minute');
  } else if (minute.startsWith('*/')) {
    const interval = minute.slice(2);
    descriptions.push(`Every ${interval} minutes`);
  } else if (hour === '*') {
    descriptions.push(`At minute ${minute} of every hour`);
  } else if (minute === '0') {
    if (hour === '*') {
      descriptions.push('At the start of every hour');
    } else if (hour.includes(',')) {
      descriptions.push(`At ${hour.split(',').join(', ')}:00`);
    } else if (hour.includes('-')) {
      const [start, end] = hour.split('-');
      descriptions.push(`Every hour from ${start}:00 to ${end}:00`);
    } else {
      descriptions.push(`At ${hour}:00`);
    }
  } else {
    descriptions.push(`At ${hour}:${minute.padStart(2, '0')}`);
  }

  // Day description
  if (dayOfMonth !== '*' || dayOfWeek !== '*') {
    if (dayOfWeek !== '*') {
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      if (dayOfWeek.includes(',')) {
        const days = dayOfWeek.split(',').map((d) => dayNames[parseInt(d)] || d);
        descriptions.push(`on ${days.join(', ')}`);
      } else if (dayOfWeek.includes('-')) {
        const [start, end] = dayOfWeek.split('-');
        descriptions.push(`${dayNames[parseInt(start)]} through ${dayNames[parseInt(end)]}`);
      } else if (dayOfWeek !== '*') {
        descriptions.push(`on ${dayNames[parseInt(dayOfWeek)]}`);
      }
    }

    if (dayOfMonth !== '*') {
      if (dayOfMonth.includes(',')) {
        descriptions.push(`on days ${dayOfMonth}`);
      } else if (dayOfMonth.includes('-')) {
        const [start, end] = dayOfMonth.split('-');
        descriptions.push(`on days ${start} through ${end}`);
      } else {
        const suffix =
          dayOfMonth === '1' || dayOfMonth === '21' || dayOfMonth === '31'
            ? 'st'
            : dayOfMonth === '2' || dayOfMonth === '22'
              ? 'nd'
              : dayOfMonth === '3' || dayOfMonth === '23'
                ? 'rd'
                : 'th';
        descriptions.push(`on the ${dayOfMonth}${suffix}`);
      }
    }
  }

  // Month description
  if (month !== '*') {
    const monthNames = [
      '',
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    if (month.includes(',')) {
      const months = month.split(',').map((m) => monthNames[parseInt(m)] || m);
      descriptions.push(`in ${months.join(', ')}`);
    } else if (month.includes('-')) {
      const [start, end] = month.split('-');
      descriptions.push(`from ${monthNames[parseInt(start)]} to ${monthNames[parseInt(end)]}`);
    } else {
      descriptions.push(`in ${monthNames[parseInt(month)]}`);
    }
  }

  return descriptions.join(' ');
}

/**
 * Create a cron iterator
 */
export function createCronIterator(
  expression: string,
  options: CronIteratorOptions = {}
): {
  next: () => Date | null;
  prev: () => Date | null;
  hasNext: () => boolean;
  hasPrev: () => boolean;
  reset: (date?: Date) => void;
} {
  const normalized = CRON_PRESETS[expression.toLowerCase()] ?? expression;

  let interval = parser.parseExpression(normalized, {
    currentDate: options.currentDate ?? new Date(),
    startDate: options.startDate,
    endDate: options.endDate,
    tz: options.timezone,
  });

  return {
    next: () => {
      try {
        return interval.next().toDate();
      } catch {
        return null;
      }
    },
    prev: () => {
      try {
        return interval.prev().toDate();
      } catch {
        return null;
      }
    },
    hasNext: () => interval.hasNext(),
    hasPrev: () => interval.hasPrev(),
    reset: (date?: Date) => {
      interval = parser.parseExpression(normalized, {
        currentDate: date ?? new Date(),
        startDate: options.startDate,
        endDate: options.endDate,
        tz: options.timezone,
      });
    },
  };
}

/**
 * Check if cron expression is valid
 */
export function isValidCronExpression(expression: string): boolean {
  return validateCronExpression(expression).valid;
}

/**
 * Get all supported timezones
 */
export function getSupportedTimezones(): string[] {
  return Intl.supportedValuesOf('timeZone');
}

/**
 * Check if timezone is valid
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// Export field info for external use
export { CRON_FIELDS };
