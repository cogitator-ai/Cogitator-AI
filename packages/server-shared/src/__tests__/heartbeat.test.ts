import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  encodeHeartbeat,
  resolveSseHeartbeatMs,
  startHeartbeat,
} from '../index';

describe('SSE heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats well under the 10 s idle timeout of Bun.serve by default', () => {
    expect(DEFAULT_SSE_HEARTBEAT_MS).toBeLessThan(10_000);
    expect(resolveSseHeartbeatMs(undefined)).toBe(DEFAULT_SSE_HEARTBEAT_MS);
  });

  it('is an SSE comment, which clients skip', () => {
    expect(encodeHeartbeat()).toMatch(/^:[^\n]*\n\n$/);
  });

  it('beats on every interval until stopped', () => {
    const beat = vi.fn(() => true);
    const stop = startHeartbeat(beat, 1_000);
    vi.advanceTimersByTime(3_500);
    expect(beat).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(beat).toHaveBeenCalledTimes(3);
  });

  it('stops by itself once the stream is gone', () => {
    const beat = vi.fn(() => false);
    startHeartbeat(beat, 1_000);
    vi.advanceTimersByTime(5_000);
    expect(beat).toHaveBeenCalledTimes(1);
  });

  it('starts nothing when turned off', () => {
    const beat = vi.fn(() => true);
    startHeartbeat(beat, resolveSseHeartbeatMs(0));
    vi.advanceTimersByTime(60_000);
    expect(beat).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses the interval %s', (value) => {
    expect(() => resolveSseHeartbeatMs(value)).toThrow(RangeError);
  });
});
