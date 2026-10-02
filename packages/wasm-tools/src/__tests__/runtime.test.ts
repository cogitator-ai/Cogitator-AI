import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pluginState = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(),
  createPlugin: vi.fn(),
}));

vi.mock('@extism/extism', () => ({
  default: pluginState.createPlugin,
  createPlugin: pluginState.createPlugin,
}));

import { invokeWasm } from '../runtime.js';

const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

let dir: string;
let modulePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wasm-runtime-'));
  modulePath = join(dir, 'tool.wasm');
  await writeFile(modulePath, MINIMAL_WASM);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  pluginState.call.mockReset();
  pluginState.close.mockReset().mockResolvedValue(undefined);
  pluginState.createPlugin.mockReset().mockImplementation(async () => ({
    call: pluginState.call,
    close: pluginState.close,
  }));
});

function invocation(overrides: Partial<Parameters<typeof invokeWasm>[0]> = {}) {
  return {
    toolName: 'tool',
    wasmModule: modulePath,
    wasmFunction: 'run',
    wasi: true,
    timeout: 1000,
    input: '{"x":1}',
    ...overrides,
  };
}

describe('invokeWasm', () => {
  it('runs the function in a worker plugin with WASI and parses JSON output', async () => {
    pluginState.call.mockResolvedValue({ text: () => '{"result":42}' });

    const result = await invokeWasm(invocation());

    expect(result).toEqual({ result: 42 });
    const [manifest, options] = pluginState.createPlugin.mock.calls[0];
    expect(manifest.wasm[0].module).toBeInstanceOf(WebAssembly.Module);
    expect(options).toEqual({ useWasi: true, runInWorker: true });
    expect(pluginState.call).toHaveBeenCalledWith('run', '{"x":1}');
    expect(pluginState.close).toHaveBeenCalledTimes(1);
  });

  it('returns raw text when output is not JSON', async () => {
    pluginState.call.mockResolvedValue({ text: () => 'plain' });
    expect(await invokeWasm(invocation())).toBe('plain');
  });

  it('reuses the compiled module until the file changes', async () => {
    pluginState.call.mockResolvedValue({ text: () => '1' });
    const compile = vi.spyOn(WebAssembly, 'compile');
    compile.mockClear();

    await invokeWasm(invocation());
    await invokeWasm(invocation());
    const firstModule = pluginState.createPlugin.mock.calls[0][0].wasm[0].module;
    expect(pluginState.createPlugin.mock.calls[1][0].wasm[0].module).toBe(firstModule);

    const future = new Date(Date.now() + 60_000);
    await utimes(modulePath, future, future);
    await invokeWasm(invocation());
    expect(pluginState.createPlugin.mock.calls[2][0].wasm[0].module).not.toBe(firstModule);
    compile.mockRestore();
  });

  it('times out, closes the worker plugin and reports the tool name', async () => {
    pluginState.call.mockImplementation(() => new Promise(() => undefined));

    await expect(invokeWasm(invocation({ timeout: 20 }))).rejects.toThrow(
      'WASM tool tool timed out after 20ms'
    );
    expect(pluginState.close).toHaveBeenCalledTimes(1);
  });

  it('aborts via the signal and closes the plugin', async () => {
    pluginState.call.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();

    const pending = invokeWasm(invocation({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);

    await expect(pending).rejects.toThrow('WASM tool tool aborted');
    expect(pluginState.close).toHaveBeenCalledTimes(1);
  });

  it('does not start a plugin when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(invokeWasm(invocation({ signal: controller.signal }))).rejects.toThrow('aborted');
    expect(pluginState.createPlugin).not.toHaveBeenCalled();
  });

  it('propagates plugin errors and missing output', async () => {
    pluginState.call.mockRejectedValueOnce(new Error('trap'));
    await expect(invokeWasm(invocation())).rejects.toThrow('trap');

    pluginState.call.mockResolvedValueOnce(null);
    await expect(invokeWasm(invocation())).rejects.toThrow('returned no output');
    expect(pluginState.close).toHaveBeenCalledTimes(2);
  });

  it('explains placeholder and invalid modules', async () => {
    const empty = join(dir, 'empty.wasm');
    await writeFile(empty, new Uint8Array());
    await expect(invokeWasm(invocation({ wasmModule: empty }))).rejects.toThrow('placeholder');

    const bogus = join(dir, 'bogus.wasm');
    await writeFile(bogus, 'not wasm');
    await expect(invokeWasm(invocation({ wasmModule: bogus }))).rejects.toThrow('bad magic bytes');
  });

  it('passes remote modules to Extism as URLs', async () => {
    pluginState.call.mockResolvedValue({ text: () => '{}' });
    await invokeWasm(invocation({ wasmModule: 'https://example.com/tool.wasm' }));
    expect(pluginState.createPlugin.mock.calls[0][0]).toEqual({
      wasm: [{ url: 'https://example.com/tool.wasm' }],
    });
  });
});
