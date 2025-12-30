import { describe, it, expect } from 'vitest';
import { regexMatch, regexReplace } from '../tools/regex.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('regexMatch tool', () => {
  it('finds all matches with global flag', async () => {
    const result = await regexMatch.execute(
      { text: 'cat bat rat', pattern: '[cbr]at' },
      mockContext
    );
    expect(result).toHaveProperty('count', 3);
    const matches = (result as { matches: { match: string }[] }).matches;
    expect(matches.map((m) => m.match)).toEqual(['cat', 'bat', 'rat']);
  });

  it('returns match positions', async () => {
    const result = await regexMatch.execute(
      { text: 'hello world', pattern: 'o' },
      mockContext
    );
    const matches = (result as { matches: { match: string; index: number }[] }).matches;
    expect(matches[0]).toEqual({ match: 'o', index: 4, groups: undefined });
    expect(matches[1]).toEqual({ match: 'o', index: 7, groups: undefined });
  });

  it('supports case-insensitive matching', async () => {
    const result = await regexMatch.execute(
      { text: 'Hello HELLO hello', pattern: 'hello', flags: 'gi' },
      mockContext
    );
    expect(result).toHaveProperty('count', 3);
  });

  it('returns named groups', async () => {
    const result = await regexMatch.execute(
      { text: 'John: 25, Jane: 30', pattern: '(?<name>\\w+): (?<age>\\d+)', flags: 'g' },
      mockContext
    );
    const matches = (result as { matches: { groups?: Record<string, string> }[] }).matches;
    expect(matches[0].groups).toEqual({ name: 'John', age: '25' });
    expect(matches[1].groups).toEqual({ name: 'Jane', age: '30' });
  });

  it('returns empty array for no matches', async () => {
    const result = await regexMatch.execute(
      { text: 'hello', pattern: 'xyz' },
      mockContext
    );
    expect(result).toHaveProperty('count', 0);
    expect((result as { matches: unknown[] }).matches).toEqual([]);
  });

  it('handles invalid regex', async () => {
    const result = await regexMatch.execute(
      { text: 'hello', pattern: '[invalid' },
      mockContext
    );
    expect(result).toHaveProperty('error');
  });

  it('works without global flag', async () => {
    const result = await regexMatch.execute(
      { text: 'cat bat rat', pattern: '[cbr]at', flags: '' },
      mockContext
    );
    expect(result).toHaveProperty('count', 1);
  });

  it('has correct metadata', () => {
    expect(regexMatch.name).toBe('regex_match');
  });
});

describe('regexReplace tool', () => {
  it('replaces all matches by default', async () => {
    const result = await regexReplace.execute(
      { text: 'cat bat rat', pattern: '[cbr]at', replacement: 'dog' },
      mockContext
    );
    expect((result as { result: string }).result).toBe('dog dog dog');
    expect(result).toHaveProperty('replacements', 3);
  });

  it('uses capture groups in replacement', async () => {
    const result = await regexReplace.execute(
      { text: 'hello world', pattern: '(\\w+) (\\w+)', replacement: '$2 $1' },
      mockContext
    );
    expect((result as { result: string }).result).toBe('world hello');
  });

  it('replaces only first match without global flag', async () => {
    const result = await regexReplace.execute(
      { text: 'cat bat rat', pattern: '[cbr]at', replacement: 'dog', flags: '' },
      mockContext
    );
    expect((result as { result: string }).result).toBe('dog bat rat');
  });

  it('handles no matches', async () => {
    const result = await regexReplace.execute(
      { text: 'hello', pattern: 'xyz', replacement: 'abc' },
      mockContext
    );
    expect((result as { result: string }).result).toBe('hello');
    expect(result).toHaveProperty('replacements', 0);
  });

  it('handles invalid regex', async () => {
    const result = await regexReplace.execute(
      { text: 'hello', pattern: '[invalid', replacement: 'x' },
      mockContext
    );
    expect(result).toHaveProperty('error');
  });

  it('has correct metadata', () => {
    expect(regexReplace.name).toBe('regex_replace');
  });
});
