import { describe, it, expect } from 'vitest';
import { NativeSandboxExecutor } from '../executors/native';
import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
} from '@cogitator-ai/types';

function assertSuccess(
  result: SandboxResult<SandboxExecutionResult>
): asserts result is { success: true; data: SandboxExecutionResult } {
  if (!result.success) {
    throw new Error(`Expected success but got error: ${result.error}`);
  }
}

describe('NativeSandboxExecutor', () => {
  const executor = new NativeSandboxExecutor();

  const defaultConfig: SandboxConfig = {
    type: 'native',
    timeout: 5000,
  };

  describe('lifecycle', () => {
    it('connects successfully', async () => {
      const result = await executor.connect();
      expect(result.success).toBe(true);
    });

    it('is always available', async () => {
      expect(await executor.isAvailable()).toBe(true);
    });

    it('disconnects successfully', async () => {
      const result = await executor.disconnect();
      expect(result.success).toBe(true);
    });
  });

  describe('execute', () => {
    it('executes simple command', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo', 'hello'],
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('hello');
      expect(result.data.exitCode).toBe(0);
      expect(result.data.timedOut).toBe(false);
    });

    it('captures stderr', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo error >&2'],
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.stderr.trim()).toBe('error');
      expect(result.data.exitCode).toBe(0);
    });

    it('returns non-zero exit code', async () => {
      const request: SandboxExecutionRequest = {
        command: ['exit 42'],
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.exitCode).toBe(42);
    });

    it('respects working directory', async () => {
      const request: SandboxExecutionRequest = {
        command: ['pwd'],
        cwd: '/tmp',
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toMatch(/\/?tmp$/);
    });

    it('uses environment variables from request', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo $TEST_VAR'],
        env: { TEST_VAR: 'test-value' },
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('test-value');
    });

    it('uses environment variables from config', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo $CONFIG_VAR'],
      };

      const config: SandboxConfig = {
        ...defaultConfig,
        env: { CONFIG_VAR: 'config-value' },
      };

      const result = await executor.execute(request, config);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('config-value');
    });

    it('request env overrides config env', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo $MY_VAR'],
        env: { MY_VAR: 'from-request' },
      };

      const config: SandboxConfig = {
        ...defaultConfig,
        env: { MY_VAR: 'from-config' },
      };

      const result = await executor.execute(request, config);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('from-request');
    });

    it('handles timeout', async () => {
      const request: SandboxExecutionRequest = {
        command: ['sleep', '10'],
        timeout: 100,
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.timedOut).toBe(true);
      expect(result.data.exitCode).toBe(124);
    });

    it('uses config timeout when request timeout not set', async () => {
      const request: SandboxExecutionRequest = {
        command: ['sleep', '10'],
      };

      const config: SandboxConfig = {
        ...defaultConfig,
        timeout: 100,
      };

      const result = await executor.execute(request, config);
      assertSuccess(result);
      expect(result.data.timedOut).toBe(true);
    });

    it('handles command not found', async () => {
      const request: SandboxExecutionRequest = {
        command: ['nonexistent-command-12345'],
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.exitCode).toBe(127);
    });

    it('runs multi-line commands', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo line1 && echo line2'],
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.stdout).toContain('line1');
      expect(result.data.stdout).toContain('line2');
    });

    it('tracks execution duration', async () => {
      const request: SandboxExecutionRequest = {
        command: ['sleep', '0.1'],
      };

      const result = await executor.execute(request, defaultConfig);
      assertSuccess(result);
      expect(result.data.duration).toBeGreaterThan(50);
      expect(result.data.duration).toBeLessThan(1000);
    });
  });
});
