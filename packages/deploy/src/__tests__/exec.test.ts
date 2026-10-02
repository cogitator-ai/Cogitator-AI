import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { run, isCommandAvailable } from '../utils/exec';

const NODE = process.execPath;

describe('run', () => {
  it('returns success and output for a passing command', () => {
    const result = run(NODE, ['--version']);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^v\d+/);
    expect(result.error).toBeUndefined();
  });

  it('returns failure for a failing command', () => {
    const result = run(NODE, ['-e', 'process.exit(1)']);
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
  });

  it('captures stderr in error field', () => {
    const result = run(NODE, ['-e', "process.stderr.write('oops'); process.exit(1)"]);
    expect(result.error).toContain('oops');
  });

  it('trims trailing whitespace from output', () => {
    expect(run(NODE, ['-e', "process.stdout.write('hello\\n')"]).output).toBe('hello');
  });

  it('accepts input via stdin', () => {
    const result = run(NODE, ['-e', "process.stdin.on('data', d => process.stdout.write(d))"], {
      input: 'hello from stdin',
    });
    expect(result.output).toBe('hello from stdin');
  });

  it('passes arguments verbatim without shell interpretation', () => {
    const tricky = 'a b; echo pwned $(whoami) "q"';
    const result = run(NODE, ['-e', 'process.stdout.write(process.argv[1])', tricky]);
    expect(result.output).toBe(tricky);
  });

  it('returns failure when a command times out', () => {
    expect(run(NODE, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 50 }).success).toBe(false);
  });

  it('returns failure for a missing executable', () => {
    const result = run('definitely-not-a-real-command-xyz', []);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('isCommandAvailable', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-path-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns true for node which is always available', () => {
    expect(isCommandAvailable('node')).toBe(true);
  });

  it('returns false for a non-existent command', () => {
    expect(isCommandAvailable('definitely-not-a-real-command-xyz')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('requires an executable file, not a directory', () => {
    mkdirSync(join(dir, 'tool-dir'));
    writeFileSync(join(dir, 'tool-file'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'tool-noexec'), '');
    chmodSync(join(dir, 'tool-file'), 0o755);
    expect(isCommandAvailable('tool-dir', dir)).toBe(false);
    expect(isCommandAvailable('tool-noexec', dir)).toBe(false);
    expect(isCommandAvailable('tool-file', dir)).toBe(true);
  });
});
