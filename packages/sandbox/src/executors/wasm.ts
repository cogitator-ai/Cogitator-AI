/**
 * WASM sandbox executor - isolated execution via Extism
 *
 * Provides fast, memory-safe execution of WASM modules.
 * Every plugin runs in its own worker thread so timeouts can terminate runaway modules.
 */

import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
  SandboxWasmConfig,
} from '@cogitator-ai/types';
import { BaseSandboxExecutor } from './base';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface WasmExecutorOptions {
  wasm?: SandboxWasmConfig;
}

interface ExtismPlugin {
  call(name: string, input: string | Uint8Array): Promise<ArrayBufferView | null>;
  close(): Promise<void>;
}

interface WasmManifest {
  wasm: Array<{ data: Uint8Array } | { url: string }>;
  memory?: { maxPages?: number };
}

type CreatePluginFn = (
  manifest: WasmManifest,
  options?: { useWasi?: boolean; runInWorker?: boolean; allowedHosts?: string[] }
) => Promise<ExtismPlugin>;

interface PluginSpec {
  key: string;
  module: string;
  useWasi: boolean;
  allowedHosts: string[];
}

interface CallOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_FUNCTION = 'run';
const MAX_OUTPUT_SIZE = 50_000;
const DEFAULT_CACHE_SIZE = 10;
const DEFAULT_MEMORY_PAGES = 256;

export class WasmSandboxExecutor extends BaseSandboxExecutor {
  readonly type = 'wasm';
  private createPlugin?: CreatePluginFn;
  private readonly idlePlugins = new Map<string, ExtismPlugin[]>();
  private readonly activePlugins = new Set<ExtismPlugin>();
  private idleCount = 0;
  private generation = 0;
  private readonly options: WasmExecutorOptions;

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
    this.generation++;
    const plugins = [...this.activePlugins, ...[...this.idlePlugins.values()].flat()];
    this.idlePlugins.clear();
    this.activePlugins.clear();
    this.idleCount = 0;
    await Promise.all(plugins.map((plugin) => this.closePlugin(plugin)));
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
    const wasmModule = config.wasmModule ?? this.options.wasm?.wasmModule;
    const functionName = config.wasmFunction ?? this.options.wasm?.functionName ?? DEFAULT_FUNCTION;

    if (!wasmModule) {
      return this.failure('No WASM module specified in config');
    }

    const allowedHosts =
      config.network?.mode === 'none' ? [] : [...(config.network?.allowedHosts ?? [])].sort();
    const useWasi = config.wasi ?? this.options.wasm?.wasi ?? false;
    const spec: PluginSpec = {
      key: JSON.stringify([wasmModule, useWasi, allowedHosts]),
      module: wasmModule,
      useWasi,
      allowedHosts,
    };

    let plugin: ExtismPlugin;
    try {
      plugin = await this.acquire(spec);
    } catch (error) {
      return this.failure(`WASM execution failed: ${describeError(error)}`);
    }

    const generation = this.generation;
    const outcome = await this.callWithTimeout(
      plugin,
      functionName,
      this.buildInput(request),
      timeout
    );

    if (outcome.timedOut || generation !== this.generation) {
      this.activePlugins.delete(plugin);
      await this.closePlugin(plugin);
    } else {
      await this.release(spec.key, plugin);
    }

    return this.success({
      stdout: outcome.stdout.slice(0, MAX_OUTPUT_SIZE),
      stderr: outcome.stderr.slice(0, MAX_OUTPUT_SIZE),
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      duration: Date.now() - startTime,
    });
  }

  private async acquire(spec: PluginSpec): Promise<ExtismPlugin> {
    const idle = this.idlePlugins.get(spec.key);
    const reused = idle?.pop();
    if (reused) {
      this.idleCount--;
      if (idle?.length === 0) this.idlePlugins.delete(spec.key);
      this.activePlugins.add(reused);
      return reused;
    }

    const manifest: WasmManifest = {
      ...(await this.loadManifest(spec.module)),
      memory: { maxPages: this.options.wasm?.memoryPages ?? DEFAULT_MEMORY_PAGES },
    };
    const plugin = await this.createPlugin!(manifest, {
      useWasi: spec.useWasi,
      runInWorker: true,
      allowedHosts: spec.allowedHosts,
    });
    this.activePlugins.add(plugin);
    return plugin;
  }

  private async release(key: string, plugin: ExtismPlugin): Promise<void> {
    this.activePlugins.delete(plugin);

    const idle = this.idlePlugins.get(key) ?? [];
    this.idlePlugins.delete(key);
    idle.push(plugin);
    this.idlePlugins.set(key, idle);
    this.idleCount++;

    const maxSize = Math.max(0, this.options.wasm?.cacheSize ?? DEFAULT_CACHE_SIZE);
    while (this.idleCount > maxSize) {
      const oldest = this.idlePlugins.keys().next();
      if (oldest.done) break;
      const plugins = this.idlePlugins.get(oldest.value) ?? [];
      const evicted = plugins.shift();
      if (plugins.length === 0) this.idlePlugins.delete(oldest.value);
      if (!evicted) continue;
      this.idleCount--;
      await this.closePlugin(evicted);
    }
  }

  private async closePlugin(plugin: ExtismPlugin): Promise<void> {
    try {
      await plugin.close();
    } catch (error) {
      console.warn(
        '[wasm] Failed to close plugin:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async loadManifest(wasmModule: string): Promise<WasmManifest> {
    if (wasmModule.startsWith('http://') || wasmModule.startsWith('https://')) {
      return { wasm: [{ url: wasmModule }] };
    }

    if (existsSync(wasmModule)) {
      return { wasm: [{ data: new Uint8Array(await readFile(wasmModule)) }] };
    }

    let resolved: string;
    try {
      resolved = createRequire(import.meta.url).resolve(wasmModule);
    } catch {
      throw new Error(`WASM module not found: ${wasmModule}`);
    }
    return { wasm: [{ data: new Uint8Array(await readFile(resolved)) }] };
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

  private async callWithTimeout(
    plugin: ExtismPlugin,
    functionName: string,
    input: string,
    timeoutMs: number
  ): Promise<CallOutcome> {
    const call = (async (): Promise<CallOutcome> => {
      try {
        const result = await plugin.call(functionName, input);
        return parseOutput(result ? new TextDecoder().decode(result) : '');
      } catch (error) {
        return {
          stdout: '',
          stderr: describeError(error),
          exitCode: 1,
          timedOut: false,
        };
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CallOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ stdout: '', stderr: 'Execution timed out', exitCode: 124, timedOut: true });
      }, timeoutMs);
    });

    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function parseOutput(output: string): CallOutcome {
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        stdout: typeof record.stdout === 'string' ? record.stdout : output,
        stderr: typeof record.stderr === 'string' ? record.stderr : '',
        exitCode: typeof record.exitCode === 'number' ? record.exitCode : 0,
        timedOut: false,
      };
    }
  } catch {
    return { stdout: output, stderr: '', exitCode: 0, timedOut: false };
  }
  return { stdout: output, stderr: '', exitCode: 0, timedOut: false };
}
