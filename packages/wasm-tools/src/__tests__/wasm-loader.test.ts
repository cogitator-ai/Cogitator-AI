import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WasmLoader } from '../manager/wasm-loader.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([0, 97, 115, 109])),
}));

vi.mock('@extism/extism', () => ({
  default: vi.fn().mockImplementation((source, _options) => {
    return Promise.resolve({
      call: vi.fn().mockResolvedValue({
        text: () => JSON.stringify({ result: 'mock' }),
        bytes: () => new Uint8Array(),
      }),
      close: vi.fn().mockResolvedValue(undefined),
      source,
    });
  }),
}));

describe('WasmLoader', () => {
  let loader: WasmLoader;

  beforeEach(() => {
    loader = new WasmLoader();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('throws if not initialized', async () => {
    await expect(loader.load('./test.wasm', false)).rejects.toThrow('WasmLoader not initialized');
  });

  it('initializes extism on first call', async () => {
    await loader.initialize();
    await loader.initialize();

    const extism = await import('@extism/extism');
    expect(extism.default).toBeDefined();
  });

  it('loads a local WASM file', async () => {
    await loader.initialize();
    const plugin = await loader.load('./test.wasm', false);

    expect(fs.readFile).toHaveBeenCalled();
    expect(plugin).toBeDefined();
    expect(plugin.call).toBeDefined();
  });

  it('loads from URL without reading file', async () => {
    await loader.initialize();
    const plugin = await loader.load('https://example.com/test.wasm', false);

    expect(fs.readFile).not.toHaveBeenCalled();
    expect(plugin).toBeDefined();
    expect((plugin as unknown as { source: { url: string } }).source).toEqual({
      url: 'https://example.com/test.wasm',
    });
  });

  it('resolves relative paths to absolute', async () => {
    await loader.initialize();
    await loader.load('./plugins/test.wasm', false);

    const readFileMock = fs.readFile as ReturnType<typeof vi.fn>;
    const calledPath = readFileMock.mock.calls[0][0] as string;
    expect(calledPath).toMatch(/\/plugins\/test\.wasm$/);
    expect(calledPath.startsWith('/')).toBe(true);
  });

  it('passes useWasi option to extism', async () => {
    await loader.initialize();
    await loader.load('./test.wasm', true);

    const extism = await import('@extism/extism');
    const createPlugin = extism.default as ReturnType<typeof vi.fn>;
    expect(createPlugin).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ useWasi: true })
    );
  });
});
