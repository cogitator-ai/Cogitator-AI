import { describe, it, expect } from 'vitest';
import { isClusterConfig, type RedisConfig } from '../types';

describe('isClusterConfig', () => {
  it('returns true for mode: cluster', () => {
    const config: RedisConfig = {
      mode: 'cluster',
      nodes: [{ host: 'localhost', port: 6379 }],
    };
    expect(isClusterConfig(config)).toBe(true);
  });

  it('returns true when nodes array present without explicit mode', () => {
    const config = {
      nodes: [{ host: 'localhost', port: 6379 }],
    } as RedisConfig;
    expect(isClusterConfig(config)).toBe(true);
  });

  it('returns false for standalone config', () => {
    const config: RedisConfig = {
      mode: 'standalone',
      url: 'redis://localhost:6379',
    };
    expect(isClusterConfig(config)).toBe(false);
  });

  it('returns false for config without mode or nodes', () => {
    const config: RedisConfig = {
      host: 'localhost',
      port: 6379,
    };
    expect(isClusterConfig(config)).toBe(false);
  });

  it('returns false when nodes is not an array', () => {
    const config = {
      nodes: 'not-an-array',
    } as unknown as RedisConfig;
    expect(isClusterConfig(config)).toBe(false);
  });
});
