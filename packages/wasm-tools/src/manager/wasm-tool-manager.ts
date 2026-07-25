import { basename } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { FileWatcher } from './file-watcher.js';
import { WasmLoader } from './wasm-loader.js';
import type {
  LoadedModule,
  PluginOutput,
  WasmToolCallbacks,
  WasmToolManagerOptions,
} from './types.js';

const DEFAULT_DEBOUNCE_MS = 100;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class WasmToolManager {
  private loader = new WasmLoader();
  private watcher: FileWatcher | null = null;
  private modules = new Map<string, LoadedModule>();
  private opQueues = new Map<string, Promise<void>>();
  private initialized = false;
  private closed = false;
  private callbacks: WasmToolCallbacks = {};
  private options: Required<WasmToolManagerOptions>;

  constructor(options: WasmToolManagerOptions = {}) {
    this.options = {
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      useWasi: options.useWasi ?? false,
    };
  }

  async watch(pattern: string, callbacks?: WasmToolCallbacks): Promise<void> {
    await this.ensureInitialized();

    if (this.watcher) {
      throw new Error('Already watching. Call close() first.');
    }

    this.callbacks = callbacks ?? {};
    this.watcher = new FileWatcher(this.options.debounceMs);

    this.watcher.watch(pattern, {
      onAdd: (path) => void this.handleAdd(path),
      onChange: (path) => void this.handleReload(path),
      onUnlink: (path) => void this.handleUnlink(path),
      onError: (error) => this.callbacks.onError?.('watcher', pattern, error),
    });
  }

  async load(wasmPath: string): Promise<Tool<unknown, unknown>> {
    await this.ensureInitialized();
    const name = this.getModuleName(wasmPath);
    return this.runSerialized(name, () => this.loadModule(wasmPath));
  }

  getTools(): Tool<unknown, unknown>[] {
    return Array.from(this.modules.values()).map((m) => m.tool);
  }

  getTool(name: string): Tool<unknown, unknown> | undefined {
    return this.modules.get(name)?.tool;
  }

  getModule(name: string): LoadedModule | undefined {
    return this.modules.get(name);
  }

  getModules(): LoadedModule[] {
    return Array.from(this.modules.values());
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    await Promise.all(Array.from(this.opQueues.values()));
    this.opQueues.clear();

    for (const mod of this.modules.values()) {
      await mod.plugin.close?.();
    }
    this.modules.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.loader.initialize();
      this.initialized = true;
    }
  }

  private runSerialized<T>(name: string, op: () => Promise<T>): Promise<T> {
    const prev = this.opQueues.get(name) ?? Promise.resolve();
    const result = prev.then(op);
    this.opQueues.set(
      name,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  private async handleAdd(wasmPath: string): Promise<void> {
    const name = this.getModuleName(wasmPath);
    await this.runSerialized(name, () => this.loadOrReload(wasmPath, 'onLoad'));
  }

  private async handleReload(wasmPath: string): Promise<void> {
    const name = this.getModuleName(wasmPath);
    await this.runSerialized(name, () => this.loadOrReload(wasmPath, 'onReload'));
  }

  private async loadOrReload(wasmPath: string, event: 'onLoad' | 'onReload'): Promise<void> {
    const name = this.getModuleName(wasmPath);
    try {
      await this.loadModule(wasmPath);
      this.callbacks[event]?.(name, wasmPath);
    } catch (error) {
      this.callbacks.onError?.(name, wasmPath, toError(error));
    }
  }

  private async handleUnlink(wasmPath: string): Promise<void> {
    const name = this.getModuleName(wasmPath);
    await this.runSerialized(name, async () => {
      try {
        const existing = this.modules.get(name);
        if (existing) {
          await existing.plugin.close?.();
          this.modules.delete(name);
          this.callbacks.onUnload?.(name, wasmPath);
        }
      } catch (error) {
        this.callbacks.onError?.(name, wasmPath, toError(error));
      }
    });
  }

  private async loadModule(wasmPath: string): Promise<Tool<unknown, unknown>> {
    if (this.closed) {
      throw new Error('WasmToolManager is closed');
    }

    const name = this.getModuleName(wasmPath);
    const existing = this.modules.get(name);
    if (existing) {
      if (existing.path !== wasmPath) {
        console.warn(
          `[wasm-tools] Module name "${name}" collision: ${wasmPath} replaces ${existing.path}`
        );
      }
      await existing.plugin.close?.();
      this.modules.delete(name);
    }

    const plugin = await this.loader.load(wasmPath, this.options.useWasi);

    if (this.closed) {
      await plugin.close?.();
      throw new Error('WasmToolManager is closed');
    }

    const tool = this.createProxyTool(name);
    this.modules.set(name, {
      name,
      path: wasmPath,
      plugin,
      tool,
      loadedAt: new Date(),
    });

    return tool;
  }

  private callPlugin(
    mod: LoadedModule,
    input: string,
    signal: AbortSignal
  ): Promise<PluginOutput | null> {
    if (signal.aborted) {
      return Promise.reject(new Error(`WASM tool ${mod.name} aborted`));
    }

    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(new Error(`WASM tool ${mod.name} aborted`));
      signal.addEventListener('abort', onAbort, { once: true });
      mod.plugin.call('run', input).then(
        (output) => {
          signal.removeEventListener('abort', onAbort);
          resolve(output);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private createProxyTool(name: string): Tool<unknown, unknown> {
    const parameters = z.record(z.string(), z.unknown());

    const tool: Tool<unknown, unknown> = {
      name,
      description: `WASM tool: ${name}`,
      parameters,
      execute: async (params: unknown, context: ToolContext) => {
        const mod = this.modules.get(name);
        if (!mod) {
          throw new Error(`Module ${name} not loaded`);
        }
        const input = JSON.stringify(params);
        const output = await this.callPlugin(mod, input, context.signal);
        if (!output) {
          throw new Error(`WASM tool ${name} returned no output`);
        }
        try {
          return JSON.parse(output.text());
        } catch {
          return output.text();
        }
      },
      toJSON: (): ToolSchema => {
        const jsonSchema = z.toJSONSchema(parameters, {
          target: 'openapi-3.0',
          unrepresentable: 'any',
        });
        const schema = jsonSchema as Record<string, unknown>;
        return {
          name,
          description: `WASM tool: ${name}`,
          parameters: {
            type: 'object',
            properties: (schema.properties ?? {}) as Record<string, unknown>,
            required: schema.required as string[] | undefined,
          },
        };
      },
    };

    return tool;
  }

  private getModuleName(wasmPath: string): string {
    return basename(wasmPath, '.wasm');
  }
}
