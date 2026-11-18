import { describe, expect, it } from 'vitest';
import { limitClock, limitOf, limitOfError, limitResetOf } from '../limit';

/** Wednesday, 18 November 2026, 10:30 in the time of this machine. */
const NOW = new Date(2026, 10, 18, 10, 30).getTime();
const at = (...parts: [number, number, number, number, number]): number =>
  new Date(...parts).getTime();

describe('limitOf', () => {
  it('reads the limit of Codex and when it says to try again', () => {
    const today = limitOf('You’ve hit your usage limit. Try again at 3:07 PM.', NOW);
    expect(today).toEqual({
      until: at(2026, 10, 18, 15, 7),
      detail: "You've hit your usage limit. Try again at 3:07 PM.",
    });
    const dated = limitOf('You’ve hit your usage limit. Try again at Nov 20th, 2026 9:15 AM.', NOW);
    expect(dated?.until).toBe(at(2026, 10, 20, 9, 15));
    const later = limitOf('You’ve hit your usage limit. Try again later.', NOW);
    expect(later).toEqual({ detail: "You've hit your usage limit. Try again later." });
    expect(
      limitOf(
        'You’ve hit your usage limit for GPT. Switch to another model now, or try again at 11:00 AM.',
        NOW
      )?.until
    ).toBe(at(2026, 10, 18, 11, 0));
  });

  it('reads the limits of Claude Code, with a time of day, a day of the week or a date', () => {
    expect(limitOf("You've hit your session limit · resets 3:45pm", NOW)?.until).toBe(
      at(2026, 10, 18, 15, 45)
    );
    expect(limitOf("You've hit your weekly limit · resets Mon 12:00am", NOW)?.until).toBe(
      at(2026, 10, 23, 0, 0)
    );
    expect(limitOf("You've hit your Opus limit · resets 9am", NOW)?.until).toBe(
      at(2026, 10, 19, 9, 0)
    );
    expect(limitOf('Usage limit reached · limit resets 3:45pm', NOW)?.until).toBe(
      at(2026, 10, 18, 15, 45)
    );
    expect(limitOf('spend limit reached · resets Dec 1', NOW)?.until).toBe(Date.UTC(2026, 11, 1));
    expect(limitOf('Credit balance is too low', NOW)).toEqual({
      detail: 'Credit balance is too low',
    });
  });

  it('reads the refusals of a model provider', () => {
    expect(limitOf('API Error: Rate limit reached', NOW)).toEqual({
      detail: 'API Error: Rate limit reached',
    });
    expect(limitOf('exceeded retry limit, last status: 429 Too Many Requests', NOW)).toBeDefined();
    expect(limitOf('You exceeded your current quota, please check your plan', NOW)).toBeDefined();
  });

  it('takes no other failure for a limit, and believes no time that cannot be right', () => {
    expect(limitOf('stream disconnected before completion', NOW)).toBeUndefined();
    expect(limitOf('unexpected status 401 Unauthorized', NOW)).toBeUndefined();
    expect(limitOf('EDQUOT: disk quota exceeded, write', NOW)).toBeUndefined();
    expect(limitOf('the quota of the team is fine', NOW)).toBeUndefined();
    expect(limitOf('', NOW)).toBeUndefined();
    expect(limitOf("You've hit your usage limit. Try again at 25:99.", NOW)?.until).toBeUndefined();
    expect(limitOf("You've hit your usage limit. Try again at 13 PM.", NOW)?.until).toBeUndefined();
    expect(
      limitOf("You've hit your usage limit. Try again at Jan 5th, 2020 3:07 PM.", NOW)?.until
    ).toBeUndefined();
    expect(
      limitOf("You've hit your usage limit. Try again at Mar 5th, 2027 3:07 PM.", NOW)?.until
    ).toBeUndefined();
  });

  it('keeps what the harness said on one line and short', () => {
    const long = `You've hit your usage limit.\nTry again later.\n${'x'.repeat(5000)}`;
    const signal = limitOf(long, NOW);
    expect(signal?.detail).toHaveLength(300);
    expect(signal?.detail).not.toContain('\n');
  });
});

describe('limitResetOf', () => {
  it('takes a time that passed a moment ago for now, not for tomorrow', () => {
    expect(limitResetOf('Try again at 10:29 AM.', NOW)).toBeUndefined();
    expect(limitResetOf('Try again at 10:30 AM.', NOW)).toBeUndefined();
    expect(limitResetOf('Try again at 10:10 AM.', NOW)).toBe(at(2026, 10, 19, 10, 10));
  });

  it('reads a stretch of time, and the first marker that names a time', () => {
    expect(limitResetOf('Rate limit reached. Try again in 4 hours.', NOW)).toBe(
      NOW + 4 * 3_600_000
    );
    expect(limitResetOf('try again in 1h 30m', NOW)).toBe(NOW + 90 * 60_000);
    expect(limitResetOf('retry in 45 seconds', NOW)).toBe(NOW + 45_000);
    expect(limitResetOf('try again in a while', NOW)).toBeUndefined();
    expect(limitResetOf('connection reset by peer, try again at 3pm', NOW)).toBe(
      at(2026, 10, 18, 15, 0)
    );
    expect(limitResetOf('the presets 9pm are loaded', NOW)).toBeUndefined();
  });

  it('takes a time of day that has passed for tomorrow', () => {
    expect(limitResetOf('resets 9:00am', NOW)).toBe(at(2026, 10, 19, 9, 0));
    expect(limitResetOf('resets at 23:15', NOW)).toBe(at(2026, 10, 18, 23, 15));
    expect(limitResetOf('Try again at 12:05 AM.', NOW)).toBe(at(2026, 10, 19, 0, 5));
    expect(limitResetOf('Try again at 12:05 PM.', NOW)).toBe(at(2026, 10, 18, 12, 5));
  });

  it('takes a day of the week for the next one, today when its time is still ahead', () => {
    expect(limitResetOf('resets Wed 6pm', NOW)).toBe(at(2026, 10, 18, 18, 0));
    expect(limitResetOf('resets Wed 9am', NOW)).toBe(at(2026, 10, 25, 9, 0));
    expect(limitResetOf('resets Sunday 1:30pm', NOW)).toBe(at(2026, 10, 22, 13, 30));
  });

  it('takes a date without a year for the next such date', () => {
    expect(limitResetOf('resets Nov 19 8:00am', NOW)).toBe(at(2026, 10, 19, 8, 0));
    expect(limitResetOf('resets Dec 1', NOW)).toBe(Date.UTC(2026, 11, 1));
    expect(limitResetOf('resets Foo 1', NOW)).toBeUndefined();
    expect(limitResetOf('no time here', NOW)).toBeUndefined();
    expect(limitResetOf('resets soon', NOW)).toBeUndefined();
  });
});

describe('limitOfError', () => {
  it('reads the codes of the runtime, with the wait the provider named', () => {
    const limited = Object.assign(new Error('[deepseek] Rate limit exceeded'), {
      code: 'LLM_RATE_LIMITED',
      retryAfter: 90_000,
    });
    expect(limitOfError(limited, NOW)).toEqual({
      until: NOW + 90_000,
      detail: '[deepseek] Rate limit exceeded',
    });
    const spent = Object.assign(new Error('[openai] Insufficient funds'), {
      code: 'LLM_QUOTA_EXCEEDED',
    });
    expect(limitOfError(spent, NOW)).toEqual({ detail: '[openai] Insufficient funds' });
  });

  it('takes no error without such a code for a limit, whatever its words', () => {
    expect(limitOfError(new Error('429 Too Many Requests'), NOW)).toBeUndefined();
    expect(limitOfError(new Error('GitHub API rate limit exceeded'), NOW)).toBeUndefined();
    expect(limitOfError(new Error('The model refused'), NOW)).toBeUndefined();
    expect(limitOfError('rate limit', NOW)).toBeUndefined();
    expect(limitOfError(undefined, NOW)).toBeUndefined();
    expect(
      limitOfError(Object.assign(new Error('boom'), { code: 'LLM_TIMEOUT' }), NOW)
    ).toBeUndefined();
  });
});

describe('limitClock', () => {
  it('shows the time, with the day when it is not today', () => {
    expect(limitClock(at(2026, 10, 18, 15, 7), NOW)).toBe('15:07');
    expect(limitClock(at(2026, 10, 20, 9, 5), NOW)).toBe('Nov 20 09:05');
  });
});
