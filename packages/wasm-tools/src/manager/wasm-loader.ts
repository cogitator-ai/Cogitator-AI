import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CreatePluginFn, ExtismPlugin, WasmSource } from './types.js';

export class WasmLoader {
  private createPlugin?: CreatePluginFn;

  async initialize(): Promise<void> {
    if (this.createPlugin) return;
    const extism = await import('@extism/extism');
    this.createPlugin = extism.default as unknown as CreatePluginFn;
  }

  async load(wasmPath: string, useWasi: boolean): Promise<ExtismPlugin> {
    if (!this.createPlugin) {
      throw new Error('WasmLoader not initialized. Call initialize() first.');
    }

    const source = await this.loadSource(wasmPath);
    return this.createPlugin(source, { useWasi });
  }

  private async loadSource(wasmPath: string): Promise<WasmSource> {
    if (wasmPath.startsWith('http://') || wasmPath.startsWith('https://')) {
      return { url: wasmPath };
    }

    const absolutePath = isAbsolute(wasmPath) ? wasmPath : resolve(process.cwd(), wasmPath);
    const wasm = await readFile(absolutePath);
    return { wasm };
  }
}
