import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WasmSandboxExecutor } from '../executors/wasm';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator-ai/types';

vi.mock('@extism/extism', () => {
  const mockCall = vi.fn();
  const mockClose = vi.fn().mockResolvedValue(undefined);

  const createPlugin = vi.fn().mockResolvedValue({
    call: mockCall,
    close: mockClose,
  });

  return {
    default: createPlugin,
    __mockCall: mockCall,
    __mockClose: mockClose,
    __mockCreatePlugin: createPlugin,
  };
});

async function getMocks() {
  const mod = await import('@extism/extism');
  return {
    mockCreatePlugin: (mod as Record<string, unknown>).__mockCreatePlugin as ReturnType<
      typeof vi.fn
    >,
    mockCall: (mod as Record<string, unknown>).__mockCall as ReturnType<typeof vi.fn>,
    mockClose: (mod as Record<string, unknown>).__mockClose as ReturnType<typeof vi.fn>,
  };
}

describe('WasmSandboxExecutor', () => {
  let executor: WasmSandboxExecutor;

  const defaultConfig: SandboxConfig = {
    type: 'wasm',
    wasmModule: 'https://example.com/module.wasm',
  };

  beforeEach(async () => {
    const { mockCreatePlugin, mockCall, mockClose } = await getMocks();
    mockCreatePlugin.mockClear();
    mockCall.mockClear();
    mockClose.mockClear();

    mockCreatePlugin.mockResolvedValue({
      call: mockCall,
      close: mockClose,
    });

    executor = new WasmSandboxExecutor();
  });

  afterEach(async () => {
    await executor.disconnect();
  });

  describe('lifecycle', () => {
    it('connects by loading extism', async () => {
      const result = await executor.connect();
      expect(result.success).toBe(true);
    });

    it('reports availability after connect', async () => {
      await executor.connect();
      expect(await executor.isAvailable()).toBe(true);
    });

    it('disconnects and clears plugin cache', async () => {
      await executor.connect();
      const result = await executor.disconnect();
      expect(result.success).toBe(true);
    });

    it('has type "wasm"', () => {
      expect(executor.type).toBe('wasm');
    });
  });

  describe('execute', () => {
    it('fails when not connected', async () => {
      const freshExecutor = new WasmSandboxExecutor();

      const result = await freshExecutor.execute({ command: ['test'] }, defaultConfig);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('WASM executor not connected');
      }
    });

    it('fails when no wasmModule specified', async () => {
      await executor.connect();

      const result = await executor.execute({ command: ['test'] }, { type: 'wasm' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('No WASM module specified in config');
      }
    });

    it('executes with JSON output from plugin', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      const output = JSON.stringify({
        stdout: 'hello wasm',
        stderr: '',
        exitCode: 0,
      });
      mockCall.mockResolvedValueOnce(new TextEncoder().encode(output));

      const request: SandboxExecutionRequest = {
        command: ['echo', 'hello'],
      };

      const result = await executor.execute(request, defaultConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe('hello wasm');
        expect(result.data.exitCode).toBe(0);
        expect(result.data.timedOut).toBe(false);
        expect(result.data.duration).toBeGreaterThanOrEqual(0);
      }
    });

    it('handles plain text output from plugin', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      mockCall.mockResolvedValueOnce(new TextEncoder().encode('plain output'));

      const result = await executor.execute({ command: ['test'] }, defaultConfig);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stdout).toBe('plain output');
        expect(result.data.exitCode).toBe(0);
      }
    });

    it('handles plugin call error', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      mockCall.mockRejectedValueOnce(new Error('plugin crash'));

      const result = await executor.execute({ command: ['test'] }, defaultConfig);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stderr).toContain('plugin crash');
        expect(result.data.exitCode).toBe(1);
      }
    });

    it('uses stdin as input when provided', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      const output = JSON.stringify({ stdout: 'got stdin', stderr: '', exitCode: 0 });
      mockCall.mockResolvedValueOnce(new TextEncoder().encode(output));

      const request: SandboxExecutionRequest = {
        command: ['process'],
        stdin: 'my input data',
      };

      const result = await executor.execute(request, defaultConfig);
      expect(result.success).toBe(true);
      expect(mockCall).toHaveBeenCalledWith('run', 'my input data');
    });

    it('uses custom wasm function name', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      const output = JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0 });
      mockCall.mockResolvedValueOnce(new TextEncoder().encode(output));

      const config: SandboxConfig = {
        ...defaultConfig,
        wasmFunction: 'customFn',
      };

      await executor.execute({ command: ['test'] }, config);
      expect(mockCall).toHaveBeenCalledWith('customFn', expect.any(String));
    });

    it('caches plugins by module+wasi key', async () => {
      await executor.connect();

      const { mockCall, mockCreatePlugin } = await getMocks();
      const output = JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0 });
      mockCall.mockResolvedValue(new TextEncoder().encode(output));

      await executor.execute({ command: ['test'] }, defaultConfig);
      await executor.execute({ command: ['test'] }, defaultConfig);

      expect(mockCreatePlugin).toHaveBeenCalledTimes(1);
    });

    it('handles timeout', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      mockCall.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 5000)));

      const request: SandboxExecutionRequest = {
        command: ['slow'],
        timeout: 50,
      };

      const result = await executor.execute(request, defaultConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timedOut).toBe(true);
        expect(result.data.exitCode).toBe(124);
      }
    }, 10_000);
  });

  describe('plugin cache eviction', () => {
    it('evicts oldest plugins when cache exceeds max size', async () => {
      const smallCacheExecutor = new WasmSandboxExecutor({ wasm: { cacheSize: 2 } });
      await smallCacheExecutor.connect();

      const { mockCall, mockCreatePlugin } = await getMocks();
      const output = JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0 });
      mockCall.mockResolvedValue(new TextEncoder().encode(output));

      await smallCacheExecutor.execute(
        { command: ['test'] },
        { type: 'wasm', wasmModule: 'https://example.com/a.wasm' }
      );
      await smallCacheExecutor.execute(
        { command: ['test'] },
        { type: 'wasm', wasmModule: 'https://example.com/b.wasm' }
      );
      await smallCacheExecutor.execute(
        { command: ['test'] },
        { type: 'wasm', wasmModule: 'https://example.com/c.wasm' }
      );

      expect(mockCreatePlugin).toHaveBeenCalledTimes(3);

      await smallCacheExecutor.disconnect();
    });
  });
});
