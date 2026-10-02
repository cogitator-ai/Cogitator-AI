import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CreatePluginFn, ExtismPlugin, WasmSource } from './types.js';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

export class WasmLoader {
  private createPlugin?: CreatePluginFn;

  async initialize(): Promise<void> {
    if (this.createPlugin) return;
    let extism: { createPlugin?: unknown; default?: unknown };
    try {
      extism = (await import('@extism/extism')) as { createPlugin?: unknown; default?: unknown };
    } catch (error) {
      throw new Error(
        `@extism/extism is required to load WASM modules: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const factory = extism.createPlugin ?? extism.default;
    if (typeof factory !== 'function') {
      throw new Error('Unable to resolve createPlugin from @extism/extism');
    }
    this.createPlugin = factory as CreatePluginFn;
  }

  async load(wasmPath: string, useWasi: boolean): Promise<ExtismPlugin> {
    if (!this.createPlugin) {
      throw new Error('WasmLoader not initialized. Call initialize() first.');
    }

    const source = await this.loadSource(wasmPath);
    return this.createPlugin(source, { useWasi, runInWorker: true });
  }

  private async loadSource(wasmPath: string): Promise<WasmSource> {
    if (wasmPath.startsWith('http://') || wasmPath.startsWith('https://')) {
      return { wasm: [{ url: wasmPath }] };
    }

    const absolutePath = isAbsolute(wasmPath) ? wasmPath : resolve(process.cwd(), wasmPath);
    const wasm = await readFile(absolutePath);
    if (wasm.length === 0) {
      throw new Error(`WASM module is empty: ${absolutePath}`);
    }
    this.assertWasmMagic(wasm, absolutePath);
    return { wasm: [{ data: wasm }] };
  }

  private assertWasmMagic(bytes: Uint8Array, path: string): void {
    const valid = bytes.length >= WASM_MAGIC.length && WASM_MAGIC.every((b, i) => bytes[i] === b);
    if (!valid) {
      throw new Error(`Not a valid WASM module (bad magic bytes): ${path}`);
    }
  }
}
