import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export interface WasmInvocation {
  toolName: string;
  wasmModule: string;
  wasmFunction: string;
  wasi: boolean;
  timeout: number;
  input: string;
  signal?: AbortSignal;
}

interface RuntimePluginOutput {
  text(): string;
}

interface RuntimePlugin {
  call(functionName: string, input: string): Promise<RuntimePluginOutput | null>;
  close(): Promise<void>;
}

type RuntimeManifest = { wasm: Array<{ module: WebAssembly.Module } | { url: string }> };

type RuntimeCreatePlugin = (
  manifest: RuntimeManifest,
  options: { useWasi: boolean; runInWorker: boolean }
) => Promise<RuntimePlugin>;

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

let factory: Promise<RuntimeCreatePlugin> | null = null;
const compiledModules = new Map<string, { mtimeMs: number; module: Promise<WebAssembly.Module> }>();

async function loadFactory(): Promise<RuntimeCreatePlugin> {
  let extism: { createPlugin?: unknown; default?: unknown };
  try {
    extism = (await import('@extism/extism')) as { createPlugin?: unknown; default?: unknown };
  } catch (error) {
    throw new Error(
      `@extism/extism is required to execute WASM tools: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const createPlugin = extism.createPlugin ?? extism.default;
  if (typeof createPlugin !== 'function') {
    throw new Error('Unable to resolve createPlugin from @extism/extism');
  }
  return createPlugin as RuntimeCreatePlugin;
}

function getFactory(): Promise<RuntimeCreatePlugin> {
  if (!factory) {
    factory = loadFactory().catch((error: unknown) => {
      factory = null;
      throw error;
    });
  }
  return factory;
}

async function compileModule(path: string): Promise<WebAssembly.Module> {
  const bytes = await readFile(path);
  if (bytes.length === 0) {
    throw new Error(
      `WASM module ${path} is empty (placeholder build). Install extism-js and rebuild @cogitator-ai/wasm-tools.`
    );
  }
  if (!WASM_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error(`Not a valid WASM module (bad magic bytes): ${path}`);
  }
  return WebAssembly.compile(bytes);
}

async function manifestFor(wasmModule: string): Promise<RuntimeManifest> {
  if (wasmModule.startsWith('http://') || wasmModule.startsWith('https://')) {
    return { wasm: [{ url: wasmModule }] };
  }

  const path = isAbsolute(wasmModule) ? wasmModule : resolve(process.cwd(), wasmModule);
  const { mtimeMs } = await stat(path);
  const cached = compiledModules.get(path);
  if (cached?.mtimeMs === mtimeMs) {
    return { wasm: [{ module: await cached.module }] };
  }

  const module = compileModule(path);
  compiledModules.set(path, { mtimeMs, module });
  try {
    return { wasm: [{ module: await module }] };
  } catch (error) {
    compiledModules.delete(path);
    throw error;
  }
}

function parseOutput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function invokeWasm(invocation: WasmInvocation): Promise<unknown> {
  const { toolName, signal, timeout } = invocation;
  if (signal?.aborted) {
    throw new Error(`WASM tool ${toolName} aborted`);
  }

  const createPlugin = await getFactory();
  const manifest = await manifestFor(invocation.wasmModule);
  const plugin = await createPlugin(manifest, { useWasi: invocation.wasi, runInWorker: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const output = await new Promise<RuntimePluginOutput | null>((resolvePromise, reject) => {
      timer = setTimeout(
        () => reject(new Error(`WASM tool ${toolName} timed out after ${timeout}ms`)),
        timeout
      );
      if (signal) {
        onAbort = () => reject(new Error(`WASM tool ${toolName} aborted`));
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      plugin
        .call(invocation.wasmFunction, invocation.input)
        .then(resolvePromise, (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error)))
        );
    });

    if (!output) {
      throw new Error(`WASM tool ${toolName} returned no output`);
    }
    return parseOutput(output.text());
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    await plugin.close().catch(() => undefined);
  }
}
