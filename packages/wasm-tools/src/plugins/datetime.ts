interface DatetimeInput {
  date?: string;
  operation: 'parse' | 'format' | 'add' | 'subtract' | 'diff' | 'now';
  format?: string;
  timezone?: string;
  amount?: number;
  unit?: 'years' | 'months' | 'days' | 'hours' | 'minutes' | 'seconds' | 'milliseconds';
  endDate?: string;
}

interface DatetimeOutput {
  result: string | number;
  iso: string;
  unix: number;
  formatted?: string;
  error?: string;
}

function parseOffset(tz?: string): number {
  if (!tz || tz === 'UTC' || tz === 'Z') return 0;

  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
  if (!match) {
    throw new Error(
      `Unsupported timezone format: "${tz}". Use UTC, Z, or an offset like +05:30 / -0800.`
    );
  }

  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  if (hours > 14 || minutes > 59) {
    throw new Error(`Timezone offset out of range: "${tz}"`);
  }

  return sign * (hours * 60 + minutes) * 60 * 1000;
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function utcDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0
): Date {
  const date = new Date(Date.UTC(2000, monthIndex, day, hour, minute, second, ms));
  date.setUTCFullYear(year);
  return date;
}

function parseDate(dateStr: string): Date {
  const trimmed = dateStr.trim();
  const iso = ISO_DATE.exec(trimmed);

  if (iso) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', fraction = '', tz] = iso;
    const year = parseInt(y, 10);
    const month = parseInt(mo, 10);
    const day = parseInt(d, 10);
    const hour = parseInt(h, 10);
    const minute = parseInt(mi, 10);
    const second = parseInt(se, 10);
    const ms = fraction ? parseInt(fraction.slice(0, 3).padEnd(3, '0'), 10) : 0;

    if (month < 1 || month > 12) throw new Error(`Invalid month in date: ${dateStr}`);
    if (day < 1 || day > daysInMonth(year, month - 1)) {
      throw new Error(`Invalid day in date: ${dateStr}`);
    }
    if (hour > 24 || minute > 59 || second > 59 || (hour === 24 && (minute || second || ms))) {
      throw new Error(`Invalid time in date: ${dateStr}`);
    }

    const date = utcDate(year, month - 1, day, hour, minute, second, ms);
    if (tz && tz !== 'Z' && tz !== 'z') {
      const normalizedTz = tz.length === 3 ? `${tz}:00` : tz;
      date.setTime(date.getTime() - parseOffset(normalizedTz));
    }
    return date;
  }

  if (/^-?\d{10,13}$/.test(trimmed)) {
    const value = parseInt(trimmed, 10);
    return new Date(trimmed.replace('-', '').length <= 10 ? value * 1000 : value);
  }

  const timestamp = Date.parse(trimmed);
  if (!isNaN(timestamp)) {
    return new Date(timestamp);
  }

  throw new Error(`Cannot parse date: ${dateStr}`);
}

const FORMAT_TOKENS = /\[([^\]]*)]|YYYY|SSS|MM|DD|HH|mm|ss|Z/g;

function formatDate(date: Date, formatStr: string, offsetMs: number = 0): string {
  const adjusted = new Date(date.getTime() + offsetMs);
  const pad = (n: number, len: number = 2) => String(n).padStart(len, '0');

  const offsetHours = Math.floor(Math.abs(offsetMs) / 3600000);
  const offsetMins = Math.floor((Math.abs(offsetMs) % 3600000) / 60000);
  const offsetSign = offsetMs >= 0 ? '+' : '-';
  const offsetStr = offsetMs === 0 ? 'Z' : `${offsetSign}${pad(offsetHours)}:${pad(offsetMins)}`;

  return formatStr.replace(FORMAT_TOKENS, (token: string, literal?: string) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY':
        return pad(adjusted.getUTCFullYear(), 4);
      case 'MM':
        return pad(adjusted.getUTCMonth() + 1);
      case 'DD':
        return pad(adjusted.getUTCDate());
      case 'HH':
        return pad(adjusted.getUTCHours());
      case 'mm':
        return pad(adjusted.getUTCMinutes());
      case 'ss':
        return pad(adjusted.getUTCSeconds());
      case 'SSS':
        return pad(adjusted.getUTCMilliseconds(), 3);
      default:
        return offsetStr;
    }
  });
}

function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const totalMonths = date.getUTCMonth() + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(targetYear, targetMonth));
  return utcDate(
    targetYear,
    targetMonth,
    day,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  );
}

function addToDate(date: Date, amount: number, unit: string): Date {
  if (!Number.isFinite(amount)) {
    throw new Error('amount must be a finite number');
  }
  const isCalendarUnit = unit === 'years' || unit === 'months' || unit === 'days';
  if (isCalendarUnit && !Number.isInteger(amount)) {
    throw new Error(`amount must be an integer for unit "${unit}"`);
  }

  switch (unit) {
    case 'years':
      return addMonths(date, amount * 12);
    case 'months':
      return addMonths(date, amount);
    case 'days': {
      const result = new Date(date.getTime());
      result.setUTCDate(result.getUTCDate() + amount);
      return result;
    }
    case 'hours':
      return new Date(date.getTime() + amount * 3600000);
    case 'minutes':
      return new Date(date.getTime() + amount * 60000);
    case 'seconds':
      return new Date(date.getTime() + amount * 1000);
    case 'milliseconds':
      return new Date(date.getTime() + amount);
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }
}

function wholeMonthsBetween(start: Date, end: Date): number {
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  if (addMonths(start, months).getTime() > end.getTime()) {
    months--;
  }
  return months;
}

function dateDiff(date1: Date, date2: Date, unit: string): number {
  const diffMs = date2.getTime() - date1.getTime();

  switch (unit) {
    case 'years':
    case 'months': {
      const months =
        diffMs >= 0 ? wholeMonthsBetween(date1, date2) : -wholeMonthsBetween(date2, date1);
      return unit === 'years' ? Math.trunc(months / 12) : months;
    }
    case 'days':
      return Math.trunc(diffMs / 86400000);
    case 'hours':
      return Math.trunc(diffMs / 3600000);
    case 'minutes':
      return Math.trunc(diffMs / 60000);
    case 'seconds':
      return Math.trunc(diffMs / 1000);
    case 'milliseconds':
      return diffMs;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }
}

export function datetime(): number {
  try {
    const inputStr = Host.inputString();
    const input: DatetimeInput = JSON.parse(inputStr);

    const offsetMs = parseOffset(input.timezone);
    let date: Date;
    let result: string | number;

    switch (input.operation) {
      case 'now':
        date = new Date();
        result = date.toISOString();
        break;

      case 'parse':
        if (!input.date) throw new Error('date is required for parse operation');
        date = parseDate(input.date);
        result = date.toISOString();
        break;

      case 'format': {
        if (!input.date) throw new Error('date is required for format operation');
        date = parseDate(input.date);
        const format = input.format ?? 'YYYY-MM-DDTHH:mm:ssZ';
        result = formatDate(date, format, offsetMs);
        break;
      }

      case 'add':
        if (!input.date) throw new Error('date is required for add operation');
        if (input.amount === undefined) throw new Error('amount is required for add operation');
        if (!input.unit) throw new Error('unit is required for add operation');
        date = parseDate(input.date);
        date = addToDate(date, input.amount, input.unit);
        result = date.toISOString();
        break;

      case 'subtract':
        if (!input.date) throw new Error('date is required for subtract operation');
        if (input.amount === undefined)
          throw new Error('amount is required for subtract operation');
        if (!input.unit) throw new Error('unit is required for subtract operation');
        date = parseDate(input.date);
        date = addToDate(date, -input.amount, input.unit);
        result = date.toISOString();
        break;

      case 'diff': {
        if (!input.date) throw new Error('date is required for diff operation');
        if (!input.endDate) throw new Error('endDate is required for diff operation');
        date = parseDate(input.date);
        const endDate = parseDate(input.endDate);
        result = dateDiff(date, endDate, input.unit ?? 'milliseconds');
        break;
      }

      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }

    const outputDate = input.operation === 'diff' ? parseDate(input.date!) : date!;

    const output: DatetimeOutput = {
      result,
      iso: outputDate.toISOString(),
      unix: Math.floor(outputDate.getTime() / 1000),
      formatted: input.format ? formatDate(outputDate, input.format, offsetMs) : undefined,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: DatetimeOutput = {
      result: '',
      iso: '',
      unix: 0,
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
