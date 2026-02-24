import { describe, it, expect } from 'vitest';
import { formatSize, formatDate } from '../commands/models.js';

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

  it('formats small sizes as MB', () => {
    expect(formatSize(100 * 1024 * 1024)).toBe('100 MB');
  });
});

describe('formatDate', () => {
  it('returns "today" for same day', () => {
    const now = new Date().toISOString();
    expect(formatDate(now)).toBe('today');
  });

  it('returns "yesterday" for 1 day ago', () => {
    const yesterday = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
    expect(formatDate(yesterday)).toBe('yesterday');
  });

  it('returns "N days ago" for 2-6 days', () => {
    const threeDays = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString();
    expect(formatDate(threeDays)).toBe('3 days ago');
  });

  it('returns "N weeks ago" for 7-29 days', () => {
    const twoWeeks = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString();
    expect(formatDate(twoWeeks)).toBe('2 weeks ago');
  });

  it('returns "N months ago" for 30+ days', () => {
    const twoMonths = new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString();
    expect(formatDate(twoMonths)).toBe('2 months ago');
  });
});
