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
  if (!match) return 0;

  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);

  return sign * (hours * 60 + minutes) * 60 * 1000;
}

function parseDate(dateStr: string): Date {
  const isoMatch =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(?:Z|([+-]\d{2}:?\d{2}))?)?$/.exec(
      dateStr
    );

  if (isoMatch) {
    const [, year, month, day, hour = '0', min = '0', sec = '0', ms = '0', tz] = isoMatch;
    const date = new Date(
      Date.UTC(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(min, 10),
        parseInt(sec, 10),
        parseInt(ms, 10)
      )
    );

    if (tz) {
      const offset = parseOffset(tz);
      date.setTime(date.getTime() - offset);
    }

    return date;
  }

  const timestamp = Date.parse(dateStr);
  if (!isNaN(timestamp)) {
    return new Date(timestamp);
  }

  throw new Error(`Cannot parse date: ${dateStr}`);
}

function formatDate(date: Date, formatStr: string, offsetMs: number = 0): string {
  const adjusted = new Date(date.getTime() + offsetMs);

  const year = adjusted.getUTCFullYear();
  const month = adjusted.getUTCMonth() + 1;
  const day = adjusted.getUTCDate();
  const hours = adjusted.getUTCHours();
  const minutes = adjusted.getUTCMinutes();
  const seconds = adjusted.getUTCSeconds();
  const ms = adjusted.getUTCMilliseconds();

  const pad = (n: number, len: number = 2) => String(n).padStart(len, '0');

  const offsetHours = Math.floor(Math.abs(offsetMs) / 3600000);
  const offsetMins = Math.floor((Math.abs(offsetMs) % 3600000) / 60000);
  const offsetSign = offsetMs >= 0 ? '+' : '-';
  const offsetStr = offsetMs === 0 ? 'Z' : `${offsetSign}${pad(offsetHours)}:${pad(offsetMins)}`;

  return formatStr
    .replace('YYYY', String(year))
    .replace('MM', pad(month))
    .replace('DD', pad(day))
    .replace('HH', pad(hours))
    .replace('mm', pad(minutes))
    .replace('ss', pad(seconds))
    .replace('SSS', pad(ms, 3))
    .replace('Z', offsetStr);
}

function addToDate(date: Date, amount: number, unit: string): Date {
  const result = new Date(date.getTime());

  switch (unit) {
    case 'years':
      result.setUTCFullYear(result.getUTCFullYear() + amount);
      break;
    case 'months':
      result.setUTCMonth(result.getUTCMonth() + amount);
      break;
    case 'days':
      result.setUTCDate(result.getUTCDate() + amount);
      break;
    case 'hours':
      result.setUTCHours(result.getUTCHours() + amount);
      break;
    case 'minutes':
      result.setUTCMinutes(result.getUTCMinutes() + amount);
      break;
    case 'seconds':
      result.setUTCSeconds(result.getUTCSeconds() + amount);
      break;
    case 'milliseconds':
      result.setTime(result.getTime() + amount);
      break;
    default:
      throw new Error(`Unknown unit: ${unit}`);
  }

  return result;
}

function dateDiff(date1: Date, date2: Date, unit: string): number {
  const diffMs = date2.getTime() - date1.getTime();

  switch (unit) {
    case 'years':
      return date2.getUTCFullYear() - date1.getUTCFullYear();
    case 'months':
      return (
        (date2.getUTCFullYear() - date1.getUTCFullYear()) * 12 +
        (date2.getUTCMonth() - date1.getUTCMonth())
      );
    case 'days':
      return Math.floor(diffMs / (24 * 60 * 60 * 1000));
    case 'hours':
      return Math.floor(diffMs / (60 * 60 * 1000));
    case 'minutes':
      return Math.floor(diffMs / (60 * 1000));
    case 'seconds':
      return Math.floor(diffMs / 1000);
    case 'milliseconds':
      return diffMs;
    default:
      return diffMs;
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
