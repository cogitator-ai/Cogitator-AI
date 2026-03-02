import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatEnvelope, formatElapsed } from '../envelope';
import type { ChannelMessage } from '@cogitator-ai/types';

function makeMsg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg1',
    channelType: 'telegram',
    channelId: 'ch1',
    userId: 'user1',
    userName: 'Alice',
    text: 'Hello world',
    raw: {},
    ...overrides,
  };
}

describe('formatElapsed', () => {
  it('formats seconds', () => {
    expect(formatElapsed(5000)).toBe('+5s');
    expect(formatElapsed(0)).toBe('+0s');
    expect(formatElapsed(59_000)).toBe('+59s');
  });

  it('formats minutes', () => {
    expect(formatElapsed(60_000)).toBe('+1m');
    expect(formatElapsed(150_000)).toBe('+2m30s');
    expect(formatElapsed(3_540_000)).toBe('+59m');
  });

  it('formats hours', () => {
    expect(formatElapsed(3_600_000)).toBe('+1h');
    expect(formatElapsed(3_900_000)).toBe('+1h5m');
  });

  it('formats days', () => {
    expect(formatElapsed(86_400_000)).toBe('+1d');
    expect(formatElapsed(97_200_000)).toBe('+1d3h');
  });

  it('handles negative values', () => {
    expect(formatElapsed(-1000)).toBe('+0s');
  });
});

describe('formatEnvelope', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T20:15:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes channel and username by default', () => {
    const result = formatEnvelope(makeMsg(), { includeTimestamp: false, includeElapsed: false });
    expect(result).toBe('[telegram | Alice] Hello world');
  });

  it('includes timestamp with UTC timezone', () => {
    const result = formatEnvelope(makeMsg(), {
      includeTimestamp: true,
      includeElapsed: false,
      timezone: 'utc',
    });
    expect(result).toMatch(/\[Feb 28.*20:15 \| telegram \| Alice\]/);
  });

  it('includes elapsed time', () => {
    const prev = Date.now() - 150_000;
    const result = formatEnvelope(
      makeMsg(),
      { includeTimestamp: false, includeElapsed: true },
      prev
    );
    expect(result).toBe('[telegram | Alice | +2m30s] Hello world');
  });

  it('omits elapsed when no previous timestamp', () => {
    const result = formatEnvelope(makeMsg(), { includeTimestamp: false, includeElapsed: true });
    expect(result).toBe('[telegram | Alice] Hello world');
  });

  it('sanitizes brackets and newlines in userName', () => {
    const result = formatEnvelope(makeMsg({ userName: 'Al[ice]\nBob' }), {
      includeTimestamp: false,
      includeElapsed: false,
    });
    expect(result).toBe('[telegram | Al ice  Bob] Hello world');
  });

  it('works with no userName', () => {
    const result = formatEnvelope(makeMsg({ userName: undefined }), {
      includeTimestamp: false,
      includeElapsed: false,
    });
    expect(result).toBe('[telegram] Hello world');
  });

  it('works with unknown channel type', () => {
    const result = formatEnvelope(makeMsg({ channelType: 'custom' }), {
      includeTimestamp: false,
      includeElapsed: false,
    });
    expect(result).toBe('[custom | Alice] Hello world');
  });

  it('includes both elapsed and timestamp', () => {
    const prev = Date.now() - 5000;
    const result = formatEnvelope(
      makeMsg(),
      { includeTimestamp: true, includeElapsed: true, timezone: 'utc' },
      prev
    );
    expect(result).toMatch(/\[Feb 28.*20:15 \| telegram \| Alice \| \+5s\] Hello world/);
  });

  it('includeSender=false omits username', () => {
    const result = formatEnvelope(makeMsg(), {
      includeTimestamp: false,
      includeElapsed: false,
      includeSender: false,
    });
    expect(result).toBe('[telegram] Hello world');
  });

  it('includeChannel=false omits channel type', () => {
    const result = formatEnvelope(makeMsg(), {
      includeTimestamp: false,
      includeElapsed: false,
      includeChannel: false,
    });
    expect(result).toBe('[Alice] Hello world');
  });

  it('includeChatType shows DM for direct messages', () => {
    const result = formatEnvelope(makeMsg(), {
      includeTimestamp: false,
      includeElapsed: false,
      includeChatType: true,
    });
    expect(result).toBe('[telegram | Alice | DM] Hello world');
  });

  it('includeChatType shows group for group messages', () => {
    const result = formatEnvelope(makeMsg({ groupId: 'grp_1' }), {
      includeTimestamp: false,
      includeElapsed: false,
      includeChatType: true,
    });
    expect(result).toBe('[telegram | Alice | group] Hello world');
  });

  it('full envelope with all fields enabled', () => {
    const prev = Date.now() - 120_000;
    const result = formatEnvelope(
      makeMsg({ groupId: 'grp_1' }),
      {
        includeTimestamp: true,
        includeElapsed: true,
        includeSender: true,
        includeChannel: true,
        includeChatType: true,
        timezone: 'utc',
      },
      prev
    );
    expect(result).toMatch(/\[Feb 28.*20:15 \| telegram \| Alice \| group \| \+2m\] Hello world/);
  });
});
