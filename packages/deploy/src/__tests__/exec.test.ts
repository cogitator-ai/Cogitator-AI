import { describe, it, expect } from 'vitest';
import { exec, isCommandAvailable } from '../utils/exec';

describe('exec', () => {
  it('returns success and output for a passing command', () => {
    const result = exec('node --version');
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^v\d+/);
    expect(result.error).toBeUndefined();
  });

  it('returns failure and error for a failing command', () => {
    const result = exec('node -e "process.exit(1)"');
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
  });

  it('captures stderr in error field', () => {
    const result = exec('node -e "process.stderr.write(\'oops\'); process.exit(1)"');
    expect(result.success).toBe(false);
    expect(result.error).toContain('oops');
  });

  it('trims trailing whitespace from output', () => {
    const result = exec('node -e "process.stdout.write(\'hello\\n\')"');
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
  });

  it('accepts input via stdin', () => {
    const result = exec(
      'node -e "process.stdin.resume(); process.stdin.on(\'data\', d => process.stdout.write(d))"',
      {
        input: 'hello from stdin',
      }
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello from stdin');
  });
});

describe('isCommandAvailable', () => {
  it('returns true for node which is always available', () => {
    expect(isCommandAvailable('node')).toBe(true);
  });

  it('returns false for a non-existent command', () => {
    expect(isCommandAvailable('definitely-not-a-real-command-xyz')).toBe(false);
  });
});
