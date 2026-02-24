import { describe, it, expect } from 'vitest';
import { parseArgs } from '../prompts.js';

describe('parseArgs', () => {
  it('parses project name from positional arg', () => {
    const result = parseArgs(['my-project']);
    expect(result.name).toBe('my-project');
  });

  it('parses --template flag', () => {
    const result = parseArgs(['--template', 'basic']);
    expect(result.template).toBe('basic');
  });

  it('parses -t shorthand for template', () => {
    const result = parseArgs(['-t', 'swarm']);
    expect(result.template).toBe('swarm');
  });

  it('ignores invalid template values', () => {
    const result = parseArgs(['--template', 'nonexistent']);
    expect(result.template).toBeUndefined();
  });

  it('does not crash when --template has no value', () => {
    expect(() => parseArgs(['--template'])).not.toThrow();
    const result = parseArgs(['--template']);
    expect(result.template).toBeUndefined();
  });

  it('does not crash when --provider has no value', () => {
    expect(() => parseArgs(['--provider'])).not.toThrow();
    const result = parseArgs(['--provider']);
    expect(result.provider).toBeUndefined();
  });

  it('does not crash when --pm has no value', () => {
    expect(() => parseArgs(['--pm'])).not.toThrow();
    const result = parseArgs(['--pm']);
    expect(result.packageManager).toBeUndefined();
  });

  it('parses --provider flag', () => {
    const result = parseArgs(['--provider', 'openai']);
    expect(result.provider).toBe('openai');
  });

  it('parses -p shorthand for provider', () => {
    const result = parseArgs(['-p', 'anthropic']);
    expect(result.provider).toBe('anthropic');
  });

  it('ignores invalid provider values', () => {
    const result = parseArgs(['--provider', 'invalid-llm']);
    expect(result.provider).toBeUndefined();
  });

  it('parses --pm flag', () => {
    const result = parseArgs(['--pm', 'npm']);
    expect(result.packageManager).toBe('npm');
  });

  it('ignores invalid package manager values', () => {
    const result = parseArgs(['--pm', 'cargo']);
    expect(result.packageManager).toBeUndefined();
  });

  it('parses --docker flag', () => {
    const result = parseArgs(['--docker']);
    expect(result.docker).toBe(true);
  });

  it('parses --no-docker flag', () => {
    const result = parseArgs(['--no-docker']);
    expect(result.docker).toBe(false);
  });

  it('parses --git flag', () => {
    const result = parseArgs(['--git']);
    expect(result.git).toBe(true);
  });

  it('parses --no-git flag', () => {
    const result = parseArgs(['--no-git']);
    expect(result.git).toBe(false);
  });

  it('parses -y flag', () => {
    const result = parseArgs(['-y']);
    expect(result.yes).toBe(true);
  });

  it('parses --yes flag', () => {
    const result = parseArgs(['--yes']);
    expect(result.yes).toBe(true);
  });

  it('parses all flags together', () => {
    const result = parseArgs([
      'my-app',
      '--template',
      'workflow',
      '--provider',
      'google',
      '--pm',
      'bun',
      '--docker',
      '--no-git',
    ]);
    expect(result.name).toBe('my-app');
    expect(result.template).toBe('workflow');
    expect(result.provider).toBe('google');
    expect(result.packageManager).toBe('bun');
    expect(result.docker).toBe(true);
    expect(result.git).toBe(false);
  });

  it('does not pick up flags as project name', () => {
    const result = parseArgs(['--docker', 'my-project']);
    expect(result.name).toBe('my-project');
  });

  it('only captures first positional as name', () => {
    const result = parseArgs(['first', 'second']);
    expect(result.name).toBe('first');
  });

  it('returns empty object for no args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({});
  });
});
