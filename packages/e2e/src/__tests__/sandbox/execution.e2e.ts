import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, NativeSandboxExecutor } from '@cogitator-ai/sandbox';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator-ai/sandbox';
import { buildExtismTestModule } from '../../helpers/extism-module';

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
      command: ['node -e "console.error(\'err output\')"'],
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
      command: ['node -e "process.exit(42)"'],
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
      command: ['echo $SANDBOX_E2E_VAR'],
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

describe('Sandbox: Native argv execution', () => {
  const executor = new NativeSandboxExecutor();

  it('keeps argument boundaries and never interprets shell syntax in argv commands', async () => {
    const result = await executor.execute(
      {
        command: [
          'node',
          '-e',
          'console.log(JSON.stringify(process.argv.slice(1)))',
          '$(id)',
          'a b',
        ],
      },
      { type: 'native' }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(JSON.parse(result.data.stdout)).toEqual(['$(id)', 'a b']);
    }
  });

  it('pipes stdin and isolates the host environment', async () => {
    process.env.SANDBOX_E2E_HOST_SECRET = 'leak';
    try {
      const result = await executor.execute(
        {
          command: [
            'node',
            '-e',
            'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d, process.env.SANDBOX_E2E_HOST_SECRET ?? "hidden"))',
          ],
          stdin: 'piped',
        },
        { type: 'native' }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout.trim()).toBe('piped hidden');
      }
    } finally {
      delete process.env.SANDBOX_E2E_HOST_SECRET;
    }
  });
});

describe('Sandbox: WASM execution', () => {
  let dir: string;
  let modulePath: string;
  let manager: SandboxManager;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cogitator-e2e-wasm-'));
    modulePath = join(dir, 'echo.wasm');
    await writeFile(modulePath, buildExtismTestModule());
    manager = new SandboxManager();
  });

  afterAll(async () => {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a local WASM module through SandboxManager', async () => {
    expect(await manager.isWasmAvailable()).toBe(true);

    const result = await manager.execute(
      { command: [], stdin: 'hello from wasm' },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'echo' }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stdout).toBe('hello from wasm');
    }
  });

  it('terminates a runaway WASM module on timeout', async () => {
    const result = await manager.execute(
      { command: [], stdin: 'x', timeout: 500 },
      { type: 'wasm', wasmModule: modulePath, wasmFunction: 'spin' }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timedOut).toBe(true);
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
  const manager = new SandboxManager();

  afterAll(async () => {
    await manager.shutdown();
  });

  it('DockerSandboxExecutor runs simple command', async () => {
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

  it('DockerSandboxExecutor streams large output split across frames', async () => {
    if (!(await manager.isDockerAvailable())) return;

    const result = await manager.execute(
      { command: ['sh', '-c', 'i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done'] },
      { type: 'docker', image: 'alpine:3.19' }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const lines = result.data.stdout.trim().split('\n');
      expect(lines).toHaveLength(2000);
      expect(lines[1999]).toBe('line-1999');
    }
  });

  it('DockerSandboxExecutor pipes stdin and isolates the network by default', async () => {
    if (!(await manager.isDockerAvailable())) return;

    const stdinResult = await manager.execute(
      { command: ['cat'], stdin: 'docker-stdin' },
      { type: 'docker', image: 'alpine:3.19' }
    );
    expect(stdinResult.success).toBe(true);
    if (stdinResult.success) {
      expect(stdinResult.data.stdout).toBe('docker-stdin');
    }

    const networkResult = await manager.execute(
      {
        command: [
          'sh',
          '-c',
          'wget -q -T 2 -O - http://example.com >/dev/null && echo online || echo offline',
        ],
      },
      { type: 'docker', image: 'alpine:3.19' }
    );
    expect(networkResult.success).toBe(true);
    if (networkResult.success) {
      expect(networkResult.data.stdout.trim()).toBe('offline');
    }
  });

  it('DockerSandboxExecutor kills commands that exceed the timeout', async () => {
    if (!(await manager.isDockerAvailable())) return;

    const result = await manager.execute(
      { command: ['sleep', '30'], timeout: 1000 },
      { type: 'docker', image: 'alpine:3.19' }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timedOut).toBe(true);
      expect(result.data.exitCode).toBe(124);
    }
  });
});
