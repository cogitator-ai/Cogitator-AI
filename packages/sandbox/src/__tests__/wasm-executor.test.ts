import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WasmSandboxExecutor } from '../executors/wasm';
import type { SandboxConfig, SandboxExecutionRequest } from '@cogitator-ai/types';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** The smallest valid module: the preamble and nothing else. */
const EMPTY_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const fetchModule = vi.fn(async () => new Response(EMPTY_MODULE));

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

    fetchModule.mockClear();
    vi.stubGlobal('fetch', fetchModule);
    executor = new WasmSandboxExecutor();
  });

  afterEach(async () => {
    await executor.disconnect();
    vi.unstubAllGlobals();
  });

  describe('module loading', () => {
    it('fetches a module URL itself so its memory can be capped', async () => {
      await executor.connect();
      const { mockCall } = await getMocks();
      mockCall.mockResolvedValue(new TextEncoder().encode('ok'));

      await executor.execute({ command: ['test'] }, defaultConfig);

      expect(fetchModule).toHaveBeenCalledWith('https://example.com/module.wasm');
    });

    it('fails the execution when the module cannot be fetched', async () => {
      await executor.connect();
      fetchModule.mockResolvedValueOnce(new Response('gone', { status: 404 }));

      const result = await executor.execute({ command: ['test'] }, defaultConfig);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('HTTP 404');
    });

    describe('from the application', () => {
      let app: string;
      const MODULE_BYTES = new Uint8Array([...EMPTY_MODULE, 0x00, 0x01, 0x00]);

      beforeEach(async () => {
        app = await mkdtemp(join(tmpdir(), 'wasm-app-'));
        const pkg = join(app, 'node_modules', '@acme', 'wasm-mods');
        await mkdir(join(pkg, 'dist', 'wasm'), { recursive: true });
        await writeFile(
          join(pkg, 'package.json'),
          JSON.stringify({ name: '@acme/wasm-mods', exports: { './wasm/*': './dist/wasm/*' } })
        );
        await writeFile(join(pkg, 'dist', 'wasm', 'calc.wasm'), MODULE_BYTES);
        await writeFile(join(app, 'local.wasm'), MODULE_BYTES);
        vi.spyOn(process, 'cwd').mockReturnValue(app);
      });

      afterEach(async () => {
        vi.restoreAllMocks();
        await rm(app, { recursive: true, force: true });
      });

      async function loadedBytes(wasmModule: string) {
        await executor.connect();
        const { mockCreatePlugin, mockCall } = await getMocks();
        mockCall.mockResolvedValue(new TextEncoder().encode('ok'));
        const result = await executor.execute({ command: [] }, { type: 'wasm', wasmModule });
        return { result, manifest: mockCreatePlugin.mock.calls.at(-1)?.[0] };
      }

      it('resolves a package specifier from the working directory', async () => {
        const { result, manifest } = await loadedBytes('@acme/wasm-mods/wasm/calc.wasm');

        expect(result.success).toBe(true);
        expect(manifest.wasm[0].data).toEqual(MODULE_BYTES);
      });

      it('resolves a relative path from the working directory', async () => {
        const { result, manifest } = await loadedBytes('./local.wasm');

        expect(result.success).toBe(true);
        expect(manifest.wasm[0].data).toEqual(MODULE_BYTES);
      });

      it('names the module and the directory when nothing matches', async () => {
        const { result } = await loadedBytes('@acme/wasm-mods/wasm/missing.wasm');

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('WASM module not found');
          expect(result.error).toContain(app);
        }
      });
    });
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

    it('marks output cut at the output limit as truncated', async () => {
      await executor.connect();

      const { mockCall } = await getMocks();
      mockCall.mockResolvedValueOnce(new TextEncoder().encode('x'.repeat(60_000)));
      mockCall.mockResolvedValueOnce(new TextEncoder().encode('short'));

      const long = await executor.execute({ command: ['test'] }, defaultConfig);
      const short = await executor.execute({ command: ['test'] }, defaultConfig);

      expect(long.success && long.data.truncated).toBe(true);
      expect(long.success && long.data.stdout.length).toBe(50_000);
      expect(short.success && short.data.truncated).toBeUndefined();
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

    it('passes the default memory limit to the plugin manifest', async () => {
      await executor.connect();

      const { mockCall, mockCreatePlugin } = await getMocks();
      mockCall.mockResolvedValue(new TextEncoder().encode('ok'));

      await executor.execute({ command: ['test'] }, defaultConfig);

      expect(mockCreatePlugin).toHaveBeenCalledWith(
        expect.objectContaining({ memory: { maxPages: 256 } }),
        expect.any(Object)
      );
    });

    it('passes configured memoryPages to the plugin manifest', async () => {
      await executor.disconnect();
      executor = new WasmSandboxExecutor({ wasm: { memoryPages: 64 } });
      await executor.connect();

      const { mockCall, mockCreatePlugin } = await getMocks();
      mockCall.mockResolvedValue(new TextEncoder().encode('ok'));

      await executor.execute({ command: ['test'] }, defaultConfig);

      expect(mockCreatePlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          wasm: [{ data: EMPTY_MODULE }],
          memory: { maxPages: 64 },
        }),
        expect.any(Object)
      );
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
