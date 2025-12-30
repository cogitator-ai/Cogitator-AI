/**
 * WASM sandbox executor - isolated execution via Extism
 *
 * Provides fast, memory-safe execution of WASM modules.
 * Cold start: 1-10ms (vs Docker 1-5s)
 * Memory: 1-10MB per plugin (vs Docker 50-200MB)
 */

import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
  SandboxWasmConfig,
} from '@cogitator/types';
import { BaseSandboxExecutor } from './base';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export interface WasmExecutorOptions {
  wasm?: SandboxWasmConfig;
}

interface ExtismPlugin {
  call(name: string, input: string | Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
}

type CreatePluginFn = (
  source: Uint8Array | string | { wasm: { url: string }[] },
  options?: { useWasi?: boolean }
) => Promise<ExtismPlugin>;

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_FUNCTION = 'run';
const MAX_OUTPUT_SIZE = 50_000;
const DEFAULT_CACHE_SIZE = 10;

export class WasmSandboxExecutor extends BaseSandboxExecutor {
  readonly type = 'wasm';
  private createPlugin?: CreatePluginFn;
  private pluginCache = new Map<string, ExtismPlugin>();
  private options: WasmExecutorOptions;
  private cacheOrder: string[] = [];

  constructor(options: WasmExecutorOptions = {}) {
    super();
    this.options = options;
  }

  async connect(): Promise<SandboxResult<void>> {
    try {
      const extism = await import('@extism/extism');
      this.createPlugin = extism.default as unknown as CreatePluginFn;
      return this.success(undefined);
    } catch (error) {
      return this.failure(
        `Failed to load Extism: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async disconnect(): Promise<SandboxResult<void>> {
    for (const plugin of this.pluginCache.values()) {
      try {
        await plugin.close();
      } catch {
      }
    }
    this.pluginCache.clear();
    this.cacheOrder = [];
    return this.success(undefined);
  }

  async isAvailable(): Promise<boolean> {
    if (!this.createPlugin) {
      const result = await this.connect();
      return result.success;
    }
    return true;
  }

  async execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>> {
    if (!this.createPlugin) {
      return this.failure('WASM executor not connected');
    }

    const startTime = Date.now();
    const timeout = request.timeout ?? config.timeout ?? DEFAULT_TIMEOUT;
    const wasmModule = config.wasmModule;
    const functionName = config.wasmFunction ?? DEFAULT_FUNCTION;

    if (!wasmModule) {
      return this.failure('No WASM module specified in config');
    }

    try {
      const plugin = await this.getOrCreatePlugin(wasmModule, config.wasi ?? false);

      const input = this.buildInput(request);
      const result = await this.executeWithTimeout(plugin, functionName, input, timeout);

      return this.success({
        stdout: result.stdout.slice(0, MAX_OUTPUT_SIZE),
        stderr: result.stderr.slice(0, MAX_OUTPUT_SIZE),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      return this.failure(
        `WASM execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getOrCreatePlugin(
    wasmModule: string,
    useWasi: boolean
  ): Promise<ExtismPlugin> {
    const cacheKey = `${wasmModule}:${useWasi}`;

    if (this.pluginCache.has(cacheKey)) {
      return this.pluginCache.get(cacheKey)!;
    }

    const source = await this.loadWasmSource(wasmModule);
    const plugin = await this.createPlugin!(source, { useWasi });

    this.pluginCache.set(cacheKey, plugin);
    this.cacheOrder.push(cacheKey);

    const maxSize = this.options.wasm?.cacheSize ?? DEFAULT_CACHE_SIZE;
    while (this.cacheOrder.length > maxSize) {
      const oldKey = this.cacheOrder.shift()!;
      const oldPlugin = this.pluginCache.get(oldKey);
      if (oldPlugin) {
        await oldPlugin.close();
        this.pluginCache.delete(oldKey);
      }
    }

    return plugin;
  }

  private async loadWasmSource(wasmModule: string): Promise<Uint8Array | { wasm: { url: string }[] }> {
    if (wasmModule.startsWith('http://') || wasmModule.startsWith('https://')) {
      return { wasm: [{ url: wasmModule }] };
    }

    if (existsSync(wasmModule)) {
      return await readFile(wasmModule);
    }

    try {
      const resolved = require.resolve(wasmModule);
      return await readFile(resolved);
    } catch {
      throw new Error(`WASM module not found: ${wasmModule}`);
    }
  }

  private buildInput(request: SandboxExecutionRequest): string {
    if (request.stdin) {
      return request.stdin;
    }
    return JSON.stringify({
      command: request.command,
      cwd: request.cwd ?? '/workspace',
      env: request.env ?? {},
    });
  }

  private async executeWithTimeout(
    plugin: ExtismPlugin,
    functionName: string,
    input: string,
    timeoutMs: number
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    const executePromise = (async () => {
      try {
        const result = await plugin.call(functionName, input);
        const output = new TextDecoder().decode(result);

        try {
          const parsed = JSON.parse(output);
          return {
            stdout: typeof parsed.stdout === 'string' ? parsed.stdout : output,
            stderr: typeof parsed.stderr === 'string' ? parsed.stderr : '',
            exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 0,
            timedOut: false,
          };
        } catch {
          return {
            stdout: output,
            stderr: '',
            exitCode: 0,
            timedOut: false,
          };
        }
      } catch (error) {
        return {
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: 1,
          timedOut: false,
        };
      }
    })();

    const timeoutPromise = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
    }>((resolve) => {
      setTimeout(() => {
        resolve({
          stdout: '',
          stderr: 'Execution timed out',
          exitCode: 124,
          timedOut: true,
        });
      }, timeoutMs);
    });

    return Promise.race([executePromise, timeoutPromise]);
  }
}
