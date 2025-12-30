import { describe, it, expect } from 'vitest';
import { exec } from '../tools/exec.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('exec tool', () => {
  it('executes simple command', async () => {
    const result = await exec.execute({ command: 'echo "hello"' }, mockContext);
    expect(result).toHaveProperty('exitCode', 0);
    expect((result as { stdout: string }).stdout.trim()).toBe('hello');
  });

  it('captures stderr', async () => {
    const result = await exec.execute({ command: 'echo "error" >&2' }, mockContext);
    expect(result).toHaveProperty('exitCode', 0);
    expect((result as { stderr: string }).stderr.trim()).toBe('error');
  });

  it('returns non-zero exit code', async () => {
    const result = await exec.execute({ command: 'exit 42' }, mockContext);
    expect((result as { exitCode: number }).exitCode).toBe(42);
  });

  it('respects working directory', async () => {
    const result = await exec.execute({ command: 'pwd', cwd: '/tmp' }, mockContext);
    // On macOS /tmp is symlinked to /private/tmp
    expect((result as { stdout: string }).stdout.trim()).toMatch(/\/?tmp$/);
  });

  it('uses custom environment variables', async () => {
    const result = await exec.execute(
      { command: 'echo $MY_VAR', env: { MY_VAR: 'test-value' } },
      mockContext
    );
    expect((result as { stdout: string }).stdout.trim()).toBe('test-value');
  });

  it('handles command timeout', async () => {
    const result = await exec.execute(
      { command: 'sleep 10', timeout: 100 },
      mockContext
    );
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('timed out');
  });

  it('handles command not found', async () => {
    const result = await exec.execute(
      { command: 'nonexistent-command-12345' },
      mockContext
    );
    // Command not found returns exit code 127 with error in stderr
    expect((result as { exitCode: number }).exitCode).toBe(127);
  });

  it('runs multi-line commands', async () => {
    const result = await exec.execute(
      { command: 'echo "line1" && echo "line2"' },
      mockContext
    );
    const stdout = (result as { stdout: string }).stdout;
    expect(stdout).toContain('line1');
    expect(stdout).toContain('line2');
  });

  it('has sideEffects declared', () => {
    expect(exec.sideEffects).toContain('process');
  });

  it('requires approval', () => {
    expect(exec.requiresApproval).toBe(true);
  });

  it('has correct metadata', () => {
    expect(exec.name).toBe('exec');
    const schema = exec.toJSON();
    expect(schema.parameters.properties).toHaveProperty('command');
    expect(schema.parameters.properties).toHaveProperty('timeout');
  });
});
