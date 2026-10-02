import { describe, it, expect } from 'vitest';
import { formatUptime, isGatewayLike } from '../commands/assistant.js';

describe('isGatewayLike', () => {
  const gateway = {
    start: async () => {},
    stop: async () => {},
    stats: {
      connectedChannels: ['telegram'],
      activeSessions: 0,
      totalSessions: 0,
      messagesToday: 0,
      uptime: 0,
    },
  };

  it('accepts a gateway-shaped object', () => {
    expect(isGatewayLike(gateway)).toBe(true);
  });

  it('rejects incomplete objects', () => {
    expect(isGatewayLike(undefined)).toBe(false);
    expect(isGatewayLike({ start: gateway.start, stats: gateway.stats })).toBe(false);
    expect(isGatewayLike({ ...gateway, stats: {} })).toBe(false);
    expect(isGatewayLike({ ...gateway, start: 'nope' })).toBe(false);
  });
});

describe('formatUptime', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatUptime(5_000)).toBe('5s');
    expect(formatUptime(125_000)).toBe('2m 5s');
    expect(formatUptime(3_725_000)).toBe('1h 2m');
  });
});
