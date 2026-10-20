import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from '../tool';
import {
  TOOL_NAME_MAX_LENGTH,
  isProviderSafeToolName,
  normalizeToolName,
  normalizeToolNames,
} from '../tool-name';

const define = (name: string) =>
  tool({
    name,
    description: 'test',
    parameters: z.object({}),
    execute: async () => 'ok',
  });

describe('tool names', () => {
  it.each(['get_weather', 'search-web', '_private', 'A', 'x'.repeat(64), 'tool_2'])(
    'accepts %s, which every provider takes',
    (name) => {
      expect(isProviderSafeToolName(name)).toBe(true);
      expect(define(name).name).toBe(name);
    }
  );

  it.each([
    ['', 'empty'],
    ['get weather', 'a space'],
    ['weather.get', 'a dot, which only Gemini takes'],
    ['ns:tool', 'a colon'],
    ['2fa_check', 'a leading digit, which Gemini refuses'],
    ['-dash', 'a leading dash'],
    ['x'.repeat(65), 'more than 64 characters'],
    ['поиск', 'non-ASCII letters'],
  ])('tool() refuses %j (%s) with the rule and a fitting name', (name) => {
    expect(isProviderSafeToolName(name)).toBe(false);
    let error: unknown;
    try {
      define(name);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TypeError);
    const message = (error as Error).message;
    expect(message).toContain(`Invalid tool name "${name}"`);
    expect(message).toContain('at most 64 characters');
    if (name) {
      const suggestion = normalizeToolName(name);
      expect(message).toContain(`For example "${suggestion}"`);
      expect(isProviderSafeToolName(suggestion)).toBe(true);
    }
  });

  it('refuses a name that is not a string', () => {
    expect(() => define(undefined as unknown as string)).toThrow('Invalid tool name undefined');
  });

  describe('normalizeToolName', () => {
    it('keeps a valid name as it is', () => {
      expect(normalizeToolName('read_file')).toBe('read_file');
    });

    it('replaces characters providers refuse and fixes the first character', () => {
      expect(normalizeToolName('Research Agent')).toBe('Research_Agent');
      expect(normalizeToolName('admin.list_users')).toBe('admin_list_users');
      expect(normalizeToolName('2fa')).toBe('_2fa');
    });

    it('cuts a long name and ends it with a hash, so long names stay distinct', () => {
      const a = normalizeToolName(`${'x'.repeat(70)}a`);
      const b = normalizeToolName(`${'x'.repeat(70)}b`);
      expect(a).toHaveLength(TOOL_NAME_MAX_LENGTH);
      expect(isProviderSafeToolName(a)).toBe(true);
      expect(a).not.toBe(b);
    });
  });

  describe('normalizeToolNames', () => {
    it('tells apart names that normalize to the same one, leaving unchanged ones alone', () => {
      const names = normalizeToolNames(['a.b', 'a_b', 'c']);
      expect(names[1]).toBe('a_b');
      expect(names[2]).toBe('c');
      expect(names[0]).toMatch(/^a_b_[0-9a-f]{8}$/);
      expect(new Set(names).size).toBe(3);
      expect(names.every(isProviderSafeToolName)).toBe(true);
    });

    it('gives every changed name its own hash when several collide', () => {
      const names = normalizeToolNames(['a.b', 'a:b']);
      expect(names[0]).not.toBe(names[1]);
      expect(names.every((name) => /^a_b_[0-9a-f]{8}$/.test(name))).toBe(true);
    });
  });
});

describe('maxResultLength', () => {
  it.each([0, -1, 1.5, Number.NaN])('tool() refuses %s', (maxResultLength) => {
    expect(() =>
      tool({
        name: 'dump',
        description: 'Dump',
        parameters: z.object({}),
        execute: async () => '',
        maxResultLength,
      })
    ).toThrow(/maxResultLength of tool "dump" must be a positive integer/);
  });

  it('takes a positive integer or Infinity', () => {
    for (const maxResultLength of [1, 5000, Infinity]) {
      expect(
        tool({
          name: 'dump',
          description: 'Dump',
          parameters: z.object({}),
          execute: async () => '',
          maxResultLength,
        }).maxResultLength
      ).toBe(maxResultLength);
    }
  });
});
