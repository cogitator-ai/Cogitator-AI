import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxManager } from '../sandbox-manager.js';
import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
} from '@cogitator/types';

function assertSuccess(
  result: SandboxResult<SandboxExecutionResult>
): asserts result is { success: true; data: SandboxExecutionResult } {
  if (!result.success) {
    throw new Error(`Expected success but got error: ${result.error}`);
  }
}

describe('SandboxManager', () => {
  let manager: SandboxManager;

  beforeEach(() => {
    manager = new SandboxManager();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe('initialization', () => {
    it('initializes successfully', async () => {
      await manager.initialize();
    });

    it('only initializes once', async () => {
      await manager.initialize();
      await manager.initialize();
    });
  });

  describe('native execution', () => {
    it('executes command with native sandbox', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo', 'hello from sandbox'],
      };

      const config: SandboxConfig = {
        type: 'native',
      };

      const result = await manager.execute(request, config);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('hello from sandbox');
      expect(result.data.exitCode).toBe(0);
    });

    it('handles command failure', async () => {
      const request: SandboxExecutionRequest = {
        command: ['exit 1'],
      };

      const config: SandboxConfig = {
        type: 'native',
      };

      const result = await manager.execute(request, config);
      assertSuccess(result);
      expect(result.data.exitCode).toBe(1);
    });

    it('handles timeout', async () => {
      const request: SandboxExecutionRequest = {
        command: ['sleep', '10'],
        timeout: 100,
      };

      const config: SandboxConfig = {
        type: 'native',
      };

      const result = await manager.execute(request, config);
      assertSuccess(result);
      expect(result.data.timedOut).toBe(true);
    });
  });

  describe('config merging', () => {
    it('merges default config with request config', async () => {
      const managerWithDefaults = new SandboxManager({
        defaults: {
          type: 'native',
          timeout: 5000,
          env: { DEFAULT_VAR: 'default' },
        },
      });

      const request: SandboxExecutionRequest = {
        command: ['echo $DEFAULT_VAR $EXTRA_VAR'],
      };

      const config: SandboxConfig = {
        type: 'native',
        env: { EXTRA_VAR: 'extra' },
      };

      const result = await managerWithDefaults.execute(request, config);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('default extra');

      await managerWithDefaults.shutdown();
    });
  });

  describe('docker fallback', () => {
    it('falls back to native when docker unavailable', async () => {
      const request: SandboxExecutionRequest = {
        command: ['echo', 'fallback test'],
      };

      const config: SandboxConfig = {
        type: 'docker',
        image: 'alpine:3.19',
      };

      const result = await manager.execute(request, config);
      assertSuccess(result);
      expect(result.data.stdout.trim()).toBe('fallback test');
    });
  });

  describe('isDockerAvailable', () => {
    it('returns boolean for docker availability', async () => {
      const available = await manager.isDockerAvailable();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('shutdown', () => {
    it('shuts down cleanly', async () => {
      await manager.initialize();
      await manager.shutdown();
      await manager.initialize();
    });

    it('can shutdown without initialization', async () => {
      await manager.shutdown();
    });
  });
});
