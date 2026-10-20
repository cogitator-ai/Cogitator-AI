import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxConfig } from '@cogitator-ai/types';
import { DockerSandboxExecutor } from '../executors/docker';
import { NativeSandboxExecutor } from '../executors/native';
import { WasmSandboxExecutor } from '../executors/wasm';
import { SandboxManager } from '../sandbox-manager';

const mockDocker = {
  ping: vi.fn().mockResolvedValue('OK'),
  createContainer: vi.fn(),
  getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
  pull: vi.fn(),
  modem: { followProgress: vi.fn() },
};

vi.mock('dockerode', () => ({
  default: function MockDockerode() {
    return mockDocker;
  },
}));

vi.mock('@extism/extism', () => {
  const call = vi.fn();
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    default: vi.fn().mockResolvedValue({ call, close }),
    __call: call,
    __close: close,
  };
});

async function extism() {
  const mod = (await import('@extism/extism')) as unknown as Record<
    string,
    ReturnType<typeof vi.fn>
  >;
  return { call: mod.__call!, close: mod.__close! };
}

function hangingStream() {
  return { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn() };
}

function container(exec: unknown) {
  return {
    id: 'c1',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(exec),
  };
}

const abortAfter = (ms: number, reason?: unknown) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(reason), ms);
  return controller.signal;
};

describe('aborting a sandbox execution', () => {
  describe('native', () => {
    const executor = new NativeSandboxExecutor();
    const config: SandboxConfig = { type: 'native', timeout: 10_000 };

    it('kills the process and fails with the reason', async () => {
      const started = Date.now();
      const result = await executor.execute(
        { command: ['sleep 5 && echo done'], signal: abortAfter(50, new Error('run cancelled')) },
        config
      );

      expect(result).toEqual({ success: false, error: 'Execution aborted: run cancelled' });
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('kills the children of a shell command too', async () => {
      const marker = join(tmpdir(), `abort-${process.pid}-${Date.now()}`);
      await executor.execute(
        { command: [`sleep 3 && touch ${marker}`], signal: abortAfter(50) },
        config
      );
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(existsSync(marker)).toBe(false);
    }, 10_000);

    it('runs nothing when the signal is already aborted', async () => {
      const result = await executor.execute(
        { command: ['echo ran'], signal: AbortSignal.abort() },
        config
      );
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/^Execution aborted/);
    });

    it('leaves a finished execution alone', async () => {
      const controller = new AbortController();
      const result = await executor.execute(
        { command: ['echo hi'], signal: controller.signal },
        config
      );
      controller.abort();
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.stdout.trim()).toBe('hi');
    });
  });

  describe('docker', () => {
    let executor: DockerSandboxExecutor;
    const config: SandboxConfig = { type: 'docker', image: 'alpine:3.19', timeout: 10_000 };

    beforeEach(async () => {
      vi.clearAllMocks();
      mockDocker.createContainer.mockImplementation(async () =>
        container({ start: vi.fn(), inspect: vi.fn() })
      );
      mockDocker.ping.mockResolvedValue('OK');
      mockDocker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) });
      executor = new DockerSandboxExecutor({ pool: { reuseContainers: true } });
      await executor.connect();
    });

    afterEach(async () => {
      await executor.disconnect();
    });

    it('stops the exec and removes the container, even one that would be reused', async () => {
      const stream = hangingStream();
      const exec = { start: vi.fn().mockResolvedValue(stream), inspect: vi.fn() };
      const box = container(exec);
      mockDocker.createContainer.mockResolvedValueOnce(box);

      const result = await executor.execute(
        { command: ['sleep', '100'], signal: abortAfter(30, 'user left') },
        config
      );

      expect(result).toEqual({ success: false, error: 'Execution aborted: user left' });
      expect(stream.end).toHaveBeenCalled();
      expect(box.remove).toHaveBeenCalledWith({ force: true });
    });

    it('never starts the command when the abort comes while the exec is being created', async () => {
      const controller = new AbortController();
      const exec = { start: vi.fn(), inspect: vi.fn() };
      const box = container(exec);
      box.exec.mockImplementation(async () => {
        controller.abort(new Error('gone'));
        return exec;
      });
      mockDocker.createContainer.mockResolvedValueOnce(box);

      const result = await executor.execute(
        { command: ['rm', '-rf', '/data'], signal: controller.signal },
        config
      );

      expect(result).toEqual({ success: false, error: 'Execution aborted: gone' });
      expect(exec.start).not.toHaveBeenCalled();
    });

    it('stops waiting for a container that is still starting, and removes it once it is up', async () => {
      const box = container({ start: vi.fn(), inspect: vi.fn() });
      let created!: (value: typeof box) => void;
      mockDocker.createContainer.mockImplementationOnce(
        () => new Promise((resolve) => (created = resolve))
      );
      const plain = new DockerSandboxExecutor();
      await plain.connect();

      const started = Date.now();
      const result = await plain.execute(
        { command: ['echo', 'hi'], signal: abortAfter(30, 'gone') },
        config
      );
      expect(result).toEqual({ success: false, error: 'Execution aborted: gone' });
      expect(Date.now() - started).toBeLessThan(1000);

      created(box);
      await vi.waitFor(() => expect(box.remove).toHaveBeenCalledWith({ force: true }));
      expect(box.exec).not.toHaveBeenCalled();
      await plain.disconnect();
    });

    it('runs nothing when the signal is already aborted', async () => {
      const result = await executor.execute(
        { command: ['echo', 'hi'], signal: AbortSignal.abort() },
        config
      );
      expect(result.success).toBe(false);
      expect(mockDocker.createContainer).not.toHaveBeenCalled();
    });
  });

  describe('wasm', () => {
    let executor: WasmSandboxExecutor;
    const config: SandboxConfig = { type: 'wasm', wasmModule: 'https://example.com/m.wasm' };

    beforeEach(async () => {
      const { call, close } = await extism();
      call.mockReset();
      close.mockClear();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])))
      );
      executor = new WasmSandboxExecutor();
      await executor.connect();
    });

    afterEach(async () => {
      await executor.disconnect();
      vi.unstubAllGlobals();
    });

    it('closes the plugin, which ends its worker, and fails', async () => {
      const { call, close } = await extism();
      call.mockImplementationOnce(() => new Promise(() => undefined));

      const result = await executor.execute(
        { command: [], stdin: '{}', timeout: 10_000, signal: abortAfter(30) },
        config
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/^Execution aborted/);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe('SandboxManager', () => {
    it('runs nothing when the signal is already aborted', async () => {
      const manager = new SandboxManager();
      const result = await manager.execute(
        { command: ['echo hi'], signal: AbortSignal.abort(new Error('gone')) },
        { type: 'native' }
      );
      expect(result).toEqual({ success: false, error: 'Execution aborted: gone' });
      await manager.shutdown();
    });
  });
});
