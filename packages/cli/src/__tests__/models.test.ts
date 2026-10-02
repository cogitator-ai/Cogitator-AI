import { describe, it, expect } from 'vitest';
import { formatSize, formatDate } from '../commands/models.js';

const DAY = 1000 * 60 * 60 * 24;
const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('formatSize', () => {
  it('formats bytes less than 1 GB as MB', () => {
    expect(formatSize(512 * 1024 * 1024)).toBe('512 MB');
  });

  it('formats bytes >= 1 GB as GB', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  it('formats fractional GB', () => {
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('formatDate', () => {
  it('returns "today" for same day', () => {
    expect(formatDate(ago(0), NOW)).toBe('today');
  });

  it('returns "yesterday" for 1 day ago', () => {
    expect(formatDate(ago(1), NOW)).toBe('yesterday');
  });

  it('returns "N days ago" for 2-6 days', () => {
    expect(formatDate(ago(3), NOW)).toBe('3 days ago');
  });

  it('uses singular week/month/year', () => {
    expect(formatDate(ago(7), NOW)).toBe('1 week ago');
    expect(formatDate(ago(35), NOW)).toBe('1 month ago');
    expect(formatDate(ago(400), NOW)).toBe('1 year ago');
  });

  it('uses plural units', () => {
    expect(formatDate(ago(14), NOW)).toBe('2 weeks ago');
    expect(formatDate(ago(60), NOW)).toBe('2 months ago');
    expect(formatDate(ago(800), NOW)).toBe('2 years ago');
  });

  it('treats future timestamps as today', () => {
    expect(formatDate(ago(-3), NOW)).toBe('today');
  });

  it('returns "unknown" for invalid dates', () => {
    expect(formatDate('not-a-date', NOW)).toBe('unknown');
    expect(formatDate('', NOW)).toBe('unknown');
  });
});
