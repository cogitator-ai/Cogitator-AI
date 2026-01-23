import type { Tool } from '@cogitator-ai/types';

export interface ExtismPlugin {
  call(functionName: string, input: string | Uint8Array): Promise<PluginOutput>;
  close?(): Promise<void>;
}

export interface PluginOutput {
  text(): string;
  bytes(): Uint8Array;
}

export type WasmSource = { wasm: Uint8Array } | { url: string };

export type CreatePluginFn = (
  source: WasmSource,
  options: { useWasi: boolean }
) => Promise<ExtismPlugin>;

export interface WasmToolManagerOptions {
  debounceMs?: number;
  useWasi?: boolean;
}

export interface WasmToolCallbacks {
  onLoad?: (name: string, path: string) => void;
  onReload?: (name: string, path: string) => void;
  onUnload?: (name: string, path: string) => void;
  onError?: (name: string, path: string, error: Error) => void;
}

export interface LoadedModule {
  name: string;
  path: string;
  plugin: ExtismPlugin;
  tool: Tool<unknown, unknown>;
  loadedAt: Date;
}

export interface FileWatcherCallbacks {
  onAdd: (path: string) => void;
  onChange: (path: string) => void;
  onUnlink: (path: string) => void;
}
