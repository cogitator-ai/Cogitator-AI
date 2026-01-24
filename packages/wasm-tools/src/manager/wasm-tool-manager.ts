import { basename } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';
import { FileWatcher } from './file-watcher.js';
import { WasmLoader } from './wasm-loader.js';
import type {
  ExtismPlugin,
  LoadedModule,
  WasmToolCallbacks,
  WasmToolManagerOptions,
} from './types.js';

const DEFAULT_DEBOUNCE_MS = 100;

export class WasmToolManager {
  private loader = new WasmLoader();
  private watcher: FileWatcher | null = null;
  private modules = new Map<string, LoadedModule>();
  private initialized = false;
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
    });
  }

  async load(wasmPath: string): Promise<Tool<unknown, unknown>> {
    await this.ensureInitialized();
    return this.loadModule(wasmPath);
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
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

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

  private async handleAdd(wasmPath: string): Promise<void> {
    const name = this.getModuleName(wasmPath);
    try {
      await this.loadModule(wasmPath);
      this.callbacks.onLoad?.(name, wasmPath);
    } catch (error) {
      this.callbacks.onError?.(name, wasmPath, error as Error);
    }
  }

  private async handleReload(wasmPath: string): Promise<void> {
    const name = this.getModuleName(wasmPath);
    try {
      const existing = this.modules.get(name);
      if (existing) {
        await existing.plugin.close?.();
      }
      await this.loadModule(wasmPath);
      this.callbacks.onReload?.(name, wasmPath);
    } catch (error) {
      this.callbacks.onError?.(name, wasmPath, error as Error);
    }
  }

  private async handleUnlink(wasmPath: string): Promise<void> {
    const name = this.getModuleName(wasmPath);
    const existing = this.modules.get(name);
    if (existing) {
      await existing.plugin.close?.();
      this.modules.delete(name);
      this.callbacks.onUnload?.(name, wasmPath);
    }
  }

  private async loadModule(wasmPath: string): Promise<Tool<unknown, unknown>> {
    const name = this.getModuleName(wasmPath);
    const plugin = await this.loader.load(wasmPath, this.options.useWasi);
    const tool = this.createProxyTool(name, plugin);

    this.modules.set(name, {
      name,
      path: wasmPath,
      plugin,
      tool,
      loadedAt: new Date(),
    });

    return tool;
  }

  private createProxyTool(name: string, _plugin: ExtismPlugin): Tool<unknown, unknown> {
    const parameters = z.record(z.string(), z.unknown());

    const tool: Tool<unknown, unknown> = {
      name,
      description: `WASM tool: ${name}`,
      parameters,
      execute: async (params: unknown, _context: ToolContext) => {
        const mod = this.modules.get(name);
        if (!mod) {
          throw new Error(`Module ${name} not loaded`);
        }
        const input = JSON.stringify(params);
        const output = await mod.plugin.call('run', input);
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
