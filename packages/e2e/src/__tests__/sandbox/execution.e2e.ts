import { describe, it, expect, afterAll } from 'vitest';
import { SandboxManager, NativeSandboxExecutor } from '@cogitator-ai/sandbox';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator-ai/sandbox';

const describeDocker = process.env.TEST_DOCKER === 'true' ? describe : describe.skip;

describe('Sandbox: Native Executor', () => {
  const executor = new NativeSandboxExecutor();

  it('NativeSandboxExecutor connects and is available', async () => {
    const connectResult = await executor.connect();
    expect(connectResult.success).toBe(true);

    const available = await executor.isAvailable();
    expect(available).toBe(true);
  });

  it('NativeSandboxExecutor runs echo command', async () => {
    const request: SandboxExecutionRequest = {
      command: ['echo', 'hello'],
    };
    const config: SandboxConfig = { type: 'native' };

    const result = await executor.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('hello');
      expect(result.data.exitCode).toBe(0);
    }
  });

  it('NativeSandboxExecutor captures stderr', async () => {
    const request: SandboxExecutionRequest = {
      command: ['node', '-e', 'console.error("err output")'],
    };
    const config: SandboxConfig = { type: 'native' };

    const result = await executor.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stderr).toContain('err output');
    }
  });

  it('NativeSandboxExecutor handles non-zero exit code', async () => {
    const request: SandboxExecutionRequest = {
      command: ['node', '-e', 'process.exit(42)'],
    };
    const config: SandboxConfig = { type: 'native' };

    const result = await executor.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exitCode).not.toBe(0);
    }
  });

  it('NativeSandboxExecutor enforces timeout', async () => {
    const request: SandboxExecutionRequest = {
      command: ['sleep', '30'],
      timeout: 1000,
    };
    const config: SandboxConfig = { type: 'native', timeout: 1000 };

    const result = await executor.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timedOut).toBe(true);
    }
  });

  it('NativeSandboxExecutor passes env vars', async () => {
    const request: SandboxExecutionRequest = {
      command: ['echo', '$SANDBOX_E2E_VAR'],
      env: { SANDBOX_E2E_VAR: 'sandbox_value' },
    };
    const config: SandboxConfig = { type: 'native' };

    const result = await executor.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('sandbox_value');
    }
  });
});

describe('Sandbox: SandboxManager', () => {
  let manager: SandboxManager;

  afterAll(async () => {
    if (manager) await manager.shutdown();
  });

  it('SandboxManager initializes with native executor', async () => {
    manager = new SandboxManager();
    await manager.initialize();

    const request: SandboxExecutionRequest = { command: ['echo', 'manager-test'] };
    const config: SandboxConfig = { type: 'native' };

    const result = await manager.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('manager-test');
    }
  });

  it('SandboxManager reports Docker availability', async () => {
    manager = new SandboxManager();
    const dockerAvailable = await manager.isDockerAvailable();
    expect(typeof dockerAvailable).toBe('boolean');
  });

  it('SandboxManager falls back gracefully when executor unavailable', async () => {
    manager = new SandboxManager();
    await manager.initialize();

    const request: SandboxExecutionRequest = { command: ['echo', 'fallback-test'] };
    const config: SandboxConfig = { type: 'wasm' };

    const result = await manager.execute(request, config);
    if (result.success) {
      expect(result.data.stdout).toContain('fallback-test');
    } else {
      expect(result.error).toBeTruthy();
    }
  });
});

describeDocker('Sandbox: Docker Executor', () => {
  let manager: SandboxManager;

  afterAll(async () => {
    if (manager) await manager.shutdown();
  });

  it('DockerSandboxExecutor runs simple command', async () => {
    manager = new SandboxManager();
    await manager.initialize();

    const dockerAvailable = await manager.isDockerAvailable();
    if (!dockerAvailable) return;

    const request: SandboxExecutionRequest = { command: ['echo', 'docker-hello'] };
    const config: SandboxConfig = { type: 'docker', image: 'alpine:3.19' };

    const result = await manager.execute(request, config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toContain('docker-hello');
    }
  });
});
