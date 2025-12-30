import { describe, it, expect } from 'vitest';
import { hash } from '../tools/hash';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('hash tool', () => {
  it('computes sha256 by default', async () => {
    const result = await hash.execute({ data: 'hello' }, mockContext);
    expect(result).toHaveProperty('hash');
    expect(result).toHaveProperty('algorithm', 'sha256');
    expect(result).toHaveProperty('encoding', 'hex');
    expect((result as { hash: string }).hash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });

  it('computes md5', async () => {
    const result = await hash.execute({ data: 'hello', algorithm: 'md5' }, mockContext);
    expect((result as { hash: string }).hash).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('computes sha1', async () => {
    const result = await hash.execute({ data: 'hello', algorithm: 'sha1' }, mockContext);
    expect((result as { hash: string }).hash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
  });

  it('computes sha512', async () => {
    const result = await hash.execute({ data: 'hello', algorithm: 'sha512' }, mockContext);
    const hashValue = (result as { hash: string }).hash;
    expect(hashValue).toHaveLength(128);
  });

  it('supports base64 encoding', async () => {
    const result = await hash.execute({ data: 'hello', algorithm: 'sha256', encoding: 'base64' }, mockContext);
    expect((result as { hash: string }).hash).toBe('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
  });

  it('produces consistent hashes', async () => {
    const result1 = await hash.execute({ data: 'test data' }, mockContext);
    const result2 = await hash.execute({ data: 'test data' }, mockContext);
    expect((result1 as { hash: string }).hash).toBe((result2 as { hash: string }).hash);
  });

  it('produces different hashes for different data', async () => {
    const result1 = await hash.execute({ data: 'data1' }, mockContext);
    const result2 = await hash.execute({ data: 'data2' }, mockContext);
    expect((result1 as { hash: string }).hash).not.toBe((result2 as { hash: string }).hash);
  });

  it('has correct metadata', () => {
    expect(hash.name).toBe('hash');
    const schema = hash.toJSON();
    expect(schema.parameters.properties).toHaveProperty('data');
    expect(schema.parameters.properties).toHaveProperty('algorithm');
  });
});
