import { describe, it, expect } from 'vitest';
import { randomNumber, randomString } from '../tools/random';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('randomNumber tool', () => {
  it('generates a number between 0 and 1 by default', async () => {
    const result = await randomNumber.execute({}, mockContext);
    expect(result).toHaveProperty('result');
    const value = (result as { result: number }).result;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  it('respects min and max bounds', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await randomNumber.execute({ min: 10, max: 20 }, mockContext);
      const value = (result as { result: number }).result;
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThan(20);
    }
  });

  it('returns integers when specified', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await randomNumber.execute({ min: 1, max: 100, integer: true }, mockContext);
      const value = (result as { result: number }).result;
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThan(100);
    }
  });

  it('returns error when min >= max', async () => {
    const result = await randomNumber.execute({ min: 10, max: 5 }, mockContext);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('min must be less than max');
  });

  it('has correct metadata', () => {
    expect(randomNumber.name).toBe('random_number');
  });
});

describe('randomString tool', () => {
  it('generates alphanumeric string by default', async () => {
    const result = await randomString.execute({ length: 20 }, mockContext);
    expect(result).toHaveProperty('result');
    const str = (result as { result: string }).result;
    expect(str).toHaveLength(20);
    expect(str).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('generates alpha-only string', async () => {
    const result = await randomString.execute({ length: 20, charset: 'alpha' }, mockContext);
    const str = (result as { result: string }).result;
    expect(str).toMatch(/^[A-Za-z]+$/);
  });

  it('generates numeric string', async () => {
    const result = await randomString.execute({ length: 20, charset: 'numeric' }, mockContext);
    const str = (result as { result: string }).result;
    expect(str).toMatch(/^[0-9]+$/);
  });

  it('generates hex string', async () => {
    const result = await randomString.execute({ length: 32, charset: 'hex' }, mockContext);
    const str = (result as { result: string }).result;
    expect(str).toMatch(/^[0-9a-f]+$/);
  });

  it('generates unique strings', async () => {
    const strings: string[] = [];
    for (let i = 0; i < 50; i++) {
      const result = await randomString.execute({ length: 32 }, mockContext);
      strings.push((result as { result: string }).result);
    }
    const unique = new Set(strings);
    expect(unique.size).toBe(50);
  });

  it('has correct metadata', () => {
    expect(randomString.name).toBe('random_string');
    const schema = randomString.toJSON();
    expect(schema.parameters.properties).toHaveProperty('length');
    expect(schema.parameters.properties).toHaveProperty('charset');
  });
});
