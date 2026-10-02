import { describe, it, expect, afterEach } from 'vitest';
import type { SandboxExecutionResult, SandboxResult } from '@cogitator-ai/types';
import { NativeSandboxExecutor } from '../executors/native';

function assertSuccess(
  result: SandboxResult<SandboxExecutionResult>
): asserts result is { success: true; data: SandboxExecutionResult } {
  if (!result.success) throw new Error(`Expected success, got: ${result.error}`);
}

describe('NativeSandboxExecutor hardening', () => {
  const executor = new NativeSandboxExecutor();

  afterEach(() => {
    delete process.env.SANDBOX_HOST_SECRET;
  });

  it('preserves argument boundaries for multi-element commands', async () => {
    const result = await executor.execute(
      {
        command: ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a b', '(c)'],
      },
      { type: 'native' }
    );

    assertSuccess(result);
    expect(JSON.parse(result.data.stdout)).toEqual(['a b', '(c)']);
    expect(result.data.exitCode).toBe(0);
  });

  it('does not interpret shell metacharacters in argv commands', async () => {
    const result = await executor.execute(
      { command: ['echo', 'safe; echo injected'] },
      { type: 'native' }
    );

    assertSuccess(result);
    expect(result.data.stdout.trim()).toBe('safe; echo injected');
  });

  it('pipes stdin to the process', async () => {
    const result = await executor.execute(
      { command: ['node', '-e', 'process.stdin.pipe(process.stdout)'], stdin: 'from stdin' },
      { type: 'native' }
    );

    assertSuccess(result);
    expect(result.data.stdout).toBe('from stdin');
  });

  it('does not leak host environment variables to executed code', async () => {
    process.env.SANDBOX_HOST_SECRET = 'top-secret';

    const result = await executor.execute(
      { command: ['echo ${SANDBOX_HOST_SECRET:-missing}'] },
      { type: 'native', env: { VISIBLE: 'yes' } }
    );

    assertSuccess(result);
    expect(result.data.stdout.trim()).toBe('missing');
  });

  it('kills the whole process tree on timeout without waiting for grandchildren', async () => {
    const started = Date.now();
    const result = await executor.execute(
      { command: ['sh', '-c', 'sleep 30; echo done'], timeout: 300 },
      { type: 'native' }
    );

    assertSuccess(result);
    expect(result.data.timedOut).toBe(true);
    expect(result.data.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('caps captured output while still draining the process', async () => {
    const result = await executor.execute(
      { command: ['node', '-e', 'process.stdout.write("x".repeat(200000))'] },
      { type: 'native' }
    );

    assertSuccess(result);
    expect(result.data.stdout.length).toBe(50_000);
    expect(result.data.exitCode).toBe(0);
  });

  it('reports 127 for missing executables in argv mode', async () => {
    const result = await executor.execute(
      { command: ['definitely-not-a-command-12345', '--flag'] },
      { type: 'native' }
    );

    assertSuccess(result);
    expect(result.data.exitCode).toBe(127);
  });
});
