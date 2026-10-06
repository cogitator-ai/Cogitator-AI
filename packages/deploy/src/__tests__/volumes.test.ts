import { describe, it, expect } from 'vitest';
import { projectVolumePaths, volumeName } from '../volumes';
import { trimEdges, trimTrailing } from '../utils/text';

describe('volume names and paths', () => {
  it.each([
    [{ path: './data' }, 'data'],
    [{ path: './.cogitator/memory.db' }, 'cogitator_memory_db'],
    [{ name: '__Chat History__', path: './x' }, 'chat_history'],
    [{ path: '___' }, 'data'],
    [{ path: `./${'a'.repeat(29)}-b` }, 'a'.repeat(29)],
  ])('names %j as %s', (volume, expected) => {
    expect(volumeName(volume)).toBe(expected);
  });

  it('keeps project volume paths without their trailing slashes', () => {
    expect(
      projectVolumePaths([{ path: './data/' }, { path: '/var/lib/x' }, { path: '../up' }])
    ).toEqual(['data']);
  });
});

describe('trimming in linear time', () => {
  const run = `${'/'.repeat(50_000)}a`;

  it('trims the end only', () => {
    expect(trimTrailing('a//', '/')).toBe('a');
    expect(trimTrailing(run, '/')).toBe(run);
  });

  it('trims both edges', () => {
    expect(trimEdges('__a_b__', '_')).toBe('a_b');
    expect(trimEdges('___', '_')).toBe('');
  });

  it('stays fast on a long run of the trimmed character', () => {
    const started = performance.now();
    trimTrailing(run, '/');
    trimEdges(`a${'_'.repeat(50_000)}a`, '_');
    expect(performance.now() - started).toBeLessThan(100);
  });
});
