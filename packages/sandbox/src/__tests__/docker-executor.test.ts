import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerSandboxExecutor } from '../executors/docker';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator-ai/types';

function createMockStream(_stdout: string, _stderr: string) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
      return this;
    },
    write: vi.fn(),
    end: vi.fn(),
    emitDockerOutput(type: number, data: string) {
      const payload = Buffer.from(data, 'utf-8');
      const header = Buffer.alloc(8);
      header[0] = type;
      header.writeUInt32BE(payload.length, 4);
      const chunk = Buffer.concat([header, payload]);
      for (const fn of listeners.data ?? []) fn(chunk);
    },
    emitEnd() {
      for (const fn of listeners.end ?? []) fn();
    },
  };
}

function createMockExec(stream: ReturnType<typeof createMockStream>, exitCode = 0) {
  return {
    start: vi.fn().mockImplementation(async () => {
      setTimeout(() => {
        stream.emitEnd();
      }, 10);
      return stream;
    }),
    inspect: vi.fn().mockResolvedValue({ ExitCode: exitCode }),
  };
}

function createMockContainer(exec: ReturnType<typeof createMockExec>, id = 'test-container-1') {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(exec),
  };
}

const mockDocker = {
  ping: vi.fn().mockResolvedValue('OK'),
  createContainer: vi.fn(),
  getImage: vi.fn().mockReturnValue({
    inspect: vi.fn().mockResolvedValue({}),
  }),
  pull: vi.fn(),
  modem: {
    followProgress: vi.fn(),
  },
};

vi.mock('dockerode', () => {
  return {
    default: function MockDockerode() {
      return mockDocker;
    },
  };
});

describe('DockerSandboxExecutor', () => {
  let executor: DockerSandboxExecutor;

  const defaultConfig: SandboxConfig = {
    type: 'docker',
    image: 'alpine:3.19',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDocker.ping.mockResolvedValue('OK');
    mockDocker.getImage.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
    });
    executor = new DockerSandboxExecutor();
  });

  afterEach(async () => {
    await executor.disconnect();
  });

  describe('lifecycle', () => {
    it('has type "docker"', () => {
      expect(executor.type).toBe('docker');
    });

    it('connects to Docker', async () => {
      const result = await executor.connect();
      expect(result.success).toBe(true);
    });

    it('returns failure when Docker ping fails', async () => {
      mockDocker.ping.mockRejectedValueOnce(new Error('Docker not running'));

      const result = await executor.connect();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Docker not running');
      }
    });

    it('checks availability via ping', async () => {
      await executor.connect();
      expect(await executor.isAvailable()).toBe(true);
    });

    it('returns false for availability when not connected', async () => {
      expect(await executor.isAvailable()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      await executor.connect();
      const result = await executor.disconnect();
      expect(result.success).toBe(true);
    });
  });

  describe('execute', () => {
    it('fails when not connected', async () => {
      const result = await executor.execute({ command: ['echo', 'hi'] }, defaultConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Docker executor not connected');
      }
    });

    it('fails with empty command', async () => {
      await executor.connect();

      const result = await executor.execute({ command: [] }, defaultConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Command array is empty');
      }
    });

    it('executes command and captures stdout', async () => {
      await executor.connect();

      const stream = createMockStream('hello docker', '');
      const exec = createMockExec(stream, 0);
      const container = createMockContainer(exec);

      mockDocker.createContainer.mockResolvedValueOnce(container);

      exec.start.mockImplementation(async () => {
        setTimeout(() => {
          stream.emitDockerOutput(1, 'hello docker');
          stream.emitEnd();
        }, 10);
        return stream;
      });

      const request: SandboxExecutionRequest = {
        command: ['echo', 'hello docker'],
      };

      const result = await executor.execute(request, defaultConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe('hello docker');
        expect(result.data.exitCode).toBe(0);
        expect(result.data.timedOut).toBe(false);
        expect(result.data.duration).toBeGreaterThanOrEqual(0);
      }
    });

    it('captures stderr separately', async () => {
      await executor.connect();

      const stream = createMockStream('', 'error msg');
      const exec = createMockExec(stream, 1);
      const container = createMockContainer(exec);

      mockDocker.createContainer.mockResolvedValueOnce(container);

      exec.start.mockImplementation(async () => {
        setTimeout(() => {
          stream.emitDockerOutput(2, 'error msg');
          stream.emitEnd();
        }, 10);
        return stream;
      });

      const result = await executor.execute({ command: ['fail'] }, defaultConfig);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stderr).toBe('error msg');
        expect(result.data.exitCode).toBe(1);
      }
    });

    it('passes environment variables', async () => {
      await executor.connect();

      const stream = createMockStream('', '');
      const exec = createMockExec(stream, 0);
      const container = createMockContainer(exec);

      mockDocker.createContainer.mockResolvedValueOnce(container);

      exec.start.mockImplementation(async () => {
        setTimeout(() => stream.emitEnd(), 10);
        return stream;
      });

      const request: SandboxExecutionRequest = {
        command: ['env'],
        env: { MY_VAR: 'test' },
      };

      const config: SandboxConfig = {
        ...defaultConfig,
        env: { CONFIG_VAR: 'config' },
      };

      await executor.execute(request, config);

      expect(container.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          Env: expect.arrayContaining(['CONFIG_VAR=config', 'MY_VAR=test']),
        })
      );
    });

    it('sends stdin when provided', async () => {
      await executor.connect();

      const stream = createMockStream('', '');
      const exec = createMockExec(stream, 0);
      const container = createMockContainer(exec);

      mockDocker.createContainer.mockResolvedValueOnce(container);

      exec.start.mockImplementation(async () => {
        setTimeout(() => stream.emitEnd(), 10);
        return stream;
      });

      const request: SandboxExecutionRequest = {
        command: ['cat'],
        stdin: 'input data',
      };

      await executor.execute(request, defaultConfig);

      expect(stream.write).toHaveBeenCalledWith('input data');
      expect(stream.end).toHaveBeenCalled();
    });

    it('uses custom working directory', async () => {
      await executor.connect();

      const stream = createMockStream('', '');
      const exec = createMockExec(stream, 0);
      const container = createMockContainer(exec);

      mockDocker.createContainer.mockResolvedValueOnce(container);

      exec.start.mockImplementation(async () => {
        setTimeout(() => stream.emitEnd(), 10);
        return stream;
      });

      const request: SandboxExecutionRequest = {
        command: ['pwd'],
        cwd: '/custom/dir',
      };

      await executor.execute(request, defaultConfig);

      expect(container.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          WorkingDir: '/custom/dir',
        })
      );
    });

    it('applies resource limits', async () => {
      await executor.connect();

      const stream = createMockStream('', '');
      const exec = createMockExec(stream, 0);
      const container = createMockContainer(exec);

      mockDocker.createContainer.mockResolvedValueOnce(container);

      exec.start.mockImplementation(async () => {
        setTimeout(() => stream.emitEnd(), 10);
        return stream;
      });

      const config: SandboxConfig = {
        ...defaultConfig,
        resources: {
          memory: '512MB',
          cpus: 0.5,
          pidsLimit: 50,
        },
      };

      await executor.execute({ command: ['test'] }, config);

      expect(mockDocker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          HostConfig: expect.objectContaining({
            Memory: 512 * 1024 * 1024,
            NanoCpus: 500_000_000,
            PidsLimit: 50,
          }),
        })
      );
    });
  });

  describe('constructor options', () => {
    it('accepts custom docker socket path', () => {
      const custom = new DockerSandboxExecutor({
        docker: { socketPath: '/custom/docker.sock' },
      });
      expect(custom).toBeDefined();
    });

    it('accepts custom pool options', () => {
      const custom = new DockerSandboxExecutor({
        pool: { maxSize: 10, idleTimeoutMs: 120_000 },
      });
      expect(custom).toBeDefined();
    });
  });
});
