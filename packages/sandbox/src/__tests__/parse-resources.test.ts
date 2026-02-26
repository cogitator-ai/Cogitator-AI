import { describe, it, expect } from 'vitest';
import { parseMemory, cpusToNanoCpus } from '../utils/parse-resources';

describe('parseMemory', () => {
  it('parses bytes without unit', () => {
    expect(parseMemory('1024')).toBe(1024);
  });

  it('parses bytes with B suffix', () => {
    expect(parseMemory('512B')).toBe(512);
  });

  it('parses kilobytes', () => {
    expect(parseMemory('1KB')).toBe(1024);
    expect(parseMemory('10KB')).toBe(10240);
  });

  it('parses megabytes', () => {
    expect(parseMemory('256MB')).toBe(256 * 1024 * 1024);
    expect(parseMemory('1MB')).toBe(1048576);
  });

  it('parses gigabytes', () => {
    expect(parseMemory('1GB')).toBe(1024 * 1024 * 1024);
    expect(parseMemory('2GB')).toBe(2 * 1024 * 1024 * 1024);
  });

  it('parses terabytes', () => {
    expect(parseMemory('1TB')).toBe(1024 * 1024 * 1024 * 1024);
  });

  it('handles decimal values', () => {
    expect(parseMemory('1.5GB')).toBe(Math.floor(1.5 * 1024 * 1024 * 1024));
    expect(parseMemory('0.5MB')).toBe(Math.floor(0.5 * 1024 * 1024));
  });

  it('is case-insensitive', () => {
    expect(parseMemory('256mb')).toBe(256 * 1024 * 1024);
    expect(parseMemory('1gb')).toBe(1024 * 1024 * 1024);
    expect(parseMemory('1Gb')).toBe(1024 * 1024 * 1024);
  });

  it('handles whitespace between value and unit', () => {
    expect(parseMemory('256 MB')).toBe(256 * 1024 * 1024);
  });

  it('throws on invalid format', () => {
    expect(() => parseMemory('')).toThrow('Invalid memory format');
    expect(() => parseMemory('abc')).toThrow('Invalid memory format');
    expect(() => parseMemory('MB')).toThrow('Invalid memory format');
    expect(() => parseMemory('-1MB')).toThrow('Invalid memory format');
  });
});

describe('cpusToNanoCpus', () => {
  it('converts full CPUs', () => {
    expect(cpusToNanoCpus(1)).toBe(1_000_000_000);
    expect(cpusToNanoCpus(2)).toBe(2_000_000_000);
  });

  it('converts fractional CPUs', () => {
    expect(cpusToNanoCpus(0.5)).toBe(500_000_000);
    expect(cpusToNanoCpus(0.25)).toBe(250_000_000);
  });

  it('handles zero', () => {
    expect(cpusToNanoCpus(0)).toBe(0);
  });

  it('floors the result', () => {
    expect(cpusToNanoCpus(0.333)).toBe(Math.floor(0.333 * 1e9));
  });
});
