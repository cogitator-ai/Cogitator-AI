import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConfigFromEnv, parseClusterNodesEnv } from '../factory';

describe('parseClusterNodesEnv', () => {
  it('returns null for undefined input', () => {
    expect(parseClusterNodesEnv(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClusterNodesEnv('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseClusterNodesEnv('not json')).toBeNull();
  });

  it('returns null for non-array JSON', () => {
    expect(parseClusterNodesEnv('{"host":"localhost"}')).toBeNull();
  });

  it('parses valid cluster nodes', () => {
    const input = JSON.stringify([
      { host: '10.0.0.1', port: 6379 },
      { host: '10.0.0.2', port: 6380 },
    ]);
    const result = parseClusterNodesEnv(input);
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({ host: '10.0.0.1', port: 6379 });
    expect(result![1]).toEqual({ host: '10.0.0.2', port: 6380 });
  });

  it('filters out invalid nodes', () => {
    const input = JSON.stringify([
      { host: '10.0.0.1', port: 6379 },
      { host: 123, port: 6380 },
      { host: '10.0.0.3', port: 'invalid' },
      null,
      { host: '10.0.0.4', port: 6381 },
    ]);
    const result = parseClusterNodesEnv(input);
    expect(result).toHaveLength(2);
    expect(result![0].host).toBe('10.0.0.1');
    expect(result![1].host).toBe('10.0.0.4');
  });
});

describe('createConfigFromEnv', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates standalone config with defaults', () => {
    const config = createConfigFromEnv({});
    expect(config).toEqual({
      mode: 'standalone',
      url: undefined,
      host: 'localhost',
      port: 6379,
      password: undefined,
      keyPrefix: 'cogitator:',
    });
  });

  it('creates standalone config from REDIS_URL', () => {
    const config = createConfigFromEnv({
      REDIS_URL: 'redis://myhost:1234',
    });
    expect(config.mode).toBe('standalone');
    expect((config as { url?: string }).url).toBe('redis://myhost:1234');
  });

  it('creates standalone config from host and port', () => {
    const config = createConfigFromEnv({
      REDIS_HOST: 'myredis.example.com',
      REDIS_PORT: '7777',
    });
    expect(config.mode).toBe('standalone');
    expect((config as { host?: string }).host).toBe('myredis.example.com');
    expect((config as { port?: number }).port).toBe(7777);
  });

  it('uses default port for invalid REDIS_PORT', () => {
    const config = createConfigFromEnv({
      REDIS_PORT: 'not-a-number',
    });
    expect((config as { port?: number }).port).toBe(6379);
  });

  it('creates cluster config when REDIS_CLUSTER_NODES is set', () => {
    const nodes = JSON.stringify([
      { host: '10.0.0.1', port: 6379 },
      { host: '10.0.0.2', port: 6379 },
    ]);
    const config = createConfigFromEnv({
      REDIS_CLUSTER_NODES: nodes,
    });
    expect(config.mode).toBe('cluster');
    expect((config as { nodes: unknown[] }).nodes).toHaveLength(2);
    expect(config.keyPrefix).toBe('{cogitator}:');
  });

  it('uses custom key prefix', () => {
    const config = createConfigFromEnv({
      REDIS_KEY_PREFIX: 'myapp:',
    });
    expect(config.keyPrefix).toBe('myapp:');
  });

  it('includes password when provided', () => {
    const config = createConfigFromEnv({
      REDIS_PASSWORD: 'secret123',
    });
    expect(config.password).toBe('secret123');
  });

  it('throws instead of falling back to localhost when REDIS_CLUSTER_NODES is invalid', () => {
    expect(() => createConfigFromEnv({ REDIS_CLUSTER_NODES: '10.0.0.1:6379' })).toThrow(
      'REDIS_CLUSTER_NODES'
    );
    expect(() => createConfigFromEnv({ REDIS_CLUSTER_NODES: '[{"host":"a"}]' })).toThrow(
      'REDIS_CLUSTER_NODES'
    );
  });

  it('ignores an empty REDIS_CLUSTER_NODES value', () => {
    expect(createConfigFromEnv({ REDIS_CLUSTER_NODES: '  ' }).mode).toBe('standalone');
  });
});
