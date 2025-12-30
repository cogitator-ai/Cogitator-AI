/**
 * DateTime tool - provides current date/time information
 */

import { z } from 'zod';
import { tool } from '../tool.js';

const datetimeParams = z.object({
  timezone: z
    .string()
    .optional()
    .describe('IANA timezone (e.g., "America/New_York", "Europe/London"). Defaults to system timezone.'),
  format: z
    .enum(['iso', 'unix', 'readable', 'date', 'time'])
    .optional()
    .describe('Output format: iso (ISO 8601), unix (timestamp), readable, date, time. Defaults to iso.'),
});

type DatetimeParams = z.infer<typeof datetimeParams>;

function formatDate(date: Date, format: DatetimeParams['format'], timezone?: string): string {
  const options: Intl.DateTimeFormatOptions = timezone ? { timeZone: timezone } : {};

  switch (format) {
    case 'unix':
      return Math.floor(date.getTime() / 1000).toString();
    case 'readable':
      return date.toLocaleString('en-US', {
        ...options,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      });
    case 'date':
      return date.toLocaleDateString('en-US', {
        ...options,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    case 'time':
      return date.toLocaleTimeString('en-US', {
        ...options,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    case 'iso':
    default:
      if (timezone) {
        const formatter = new Intl.DateTimeFormat('en-CA', {
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
        const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
        return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
      }
      return date.toISOString();
  }
}

export const datetime = tool({
  name: 'datetime',
  description:
    'Get the current date and time. Supports different timezones and output formats (ISO 8601, Unix timestamp, readable, date only, time only).',
  parameters: datetimeParams,
  execute: async ({ timezone, format }) => {
    try {
      const now = new Date();

      if (timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: timezone });
        } catch {
          return { error: `Invalid timezone: ${timezone}`, timezone };
        }
      }

      const formatted = formatDate(now, format, timezone);
      return {
        datetime: formatted,
        timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        format: format ?? 'iso',
      };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
});
