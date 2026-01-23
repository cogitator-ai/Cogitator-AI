import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WasmToolManager } from '../manager/wasm-tool-manager.js';

vi.mock('../manager/wasm-loader.js', () => ({
  WasmLoader: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockImplementation((path: string) => {
      return Promise.resolve({
        call: vi.fn().mockResolvedValue({
          text: () => JSON.stringify({ result: `executed-${path}` }),
          bytes: () => new Uint8Array(),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    }),
  })),
}));

vi.mock('../manager/file-watcher.js', () => ({
  FileWatcher: vi.fn().mockImplementation(() => {
    const instance = {
      watch: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      _callbacks: null as {
        onAdd: (p: string) => void;
        onChange: (p: string) => void;
        onUnlink: (p: string) => void;
      } | null,
    };
    instance.watch = vi.fn().mockImplementation((_pattern, callbacks) => {
      instance._callbacks = callbacks;
    });
    return instance;
  }),
}));

describe('WasmToolManager', () => {
  let manager: WasmToolManager;

  beforeEach(() => {
    manager = new WasmToolManager({ debounceMs: 50 });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.close();
  });

  describe('load()', () => {
    it('loads a single WASM module', async () => {
      const tool = await manager.load('./calc.wasm');

      expect(tool.name).toBe('calc');
      expect(tool.description).toBe('WASM tool: calc');
      expect(tool.execute).toBeDefined();
    });

    it('returns the same tool for same path', async () => {
      const tool1 = await manager.load('./calc.wasm');
      const tool2 = await manager.load('./calc.wasm');

      expect(tool1.name).toBe(tool2.name);
    });

    it('loads multiple different modules', async () => {
      const calc = await manager.load('./calc.wasm');
      const hash = await manager.load('./hash.wasm');

      expect(calc.name).toBe('calc');
      expect(hash.name).toBe('hash');
      expect(manager.getTools()).toHaveLength(2);
    });
  });

  describe('getTools()', () => {
    it('returns empty array when no modules loaded', () => {
      expect(manager.getTools()).toEqual([]);
    });

    it('returns all loaded tools', async () => {
      await manager.load('./calc.wasm');
      await manager.load('./hash.wasm');

      const tools = manager.getTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name).sort()).toEqual(['calc', 'hash']);
    });
  });

  describe('getTool()', () => {
    it('returns undefined for non-existent tool', () => {
      expect(manager.getTool('nonexistent')).toBeUndefined();
    });

    it('returns the tool by name', async () => {
      await manager.load('./calc.wasm');

      const tool = manager.getTool('calc');
      expect(tool?.name).toBe('calc');
    });
  });

  describe('getModule()', () => {
    it('returns module info with metadata', async () => {
      await manager.load('./calc.wasm');

      const mod = manager.getModule('calc');
      expect(mod).toBeDefined();
      expect(mod?.name).toBe('calc');
      expect(mod?.path).toBe('./calc.wasm');
      expect(mod?.loadedAt).toBeInstanceOf(Date);
      expect(mod?.plugin).toBeDefined();
      expect(mod?.tool).toBeDefined();
    });
  });

  describe('watch()', () => {
    it('starts watching for WASM files', async () => {
      const callbacks = {
        onLoad: vi.fn(),
        onReload: vi.fn(),
        onError: vi.fn(),
      };

      await manager.watch('./plugins/*.wasm', callbacks);

      const { FileWatcher } = await import('../manager/file-watcher.js');
      const watcherInstance = (FileWatcher as ReturnType<typeof vi.fn>).mock.results[0].value;

      expect(watcherInstance.watch).toHaveBeenCalledWith('./plugins/*.wasm', expect.any(Object));
    });

    it('throws if watch called twice', async () => {
      await manager.watch('./plugins/*.wasm');
      await expect(manager.watch('./other/*.wasm')).rejects.toThrow('Already watching');
    });

    it('calls onLoad when file is added', async () => {
      const onLoad = vi.fn();
      await manager.watch('./plugins/*.wasm', { onLoad });

      const { FileWatcher } = await import('../manager/file-watcher.js');
      const watcherInstance = (FileWatcher as ReturnType<typeof vi.fn>).mock.results[0].value;

      watcherInstance._callbacks?.onAdd('./plugins/calc.wasm');
      await vi.waitFor(() => {
        expect(onLoad).toHaveBeenCalledWith('calc', './plugins/calc.wasm');
      });
    });

    it('calls onReload when file changes', async () => {
      const onReload = vi.fn();
      await manager.watch('./plugins/*.wasm', { onReload });

      const { FileWatcher } = await import('../manager/file-watcher.js');
      const watcherInstance = (FileWatcher as ReturnType<typeof vi.fn>).mock.results[0].value;

      watcherInstance._callbacks?.onAdd('./plugins/calc.wasm');
      await vi.waitFor(() => {
        expect(manager.getTool('calc')).toBeDefined();
      });

      watcherInstance._callbacks?.onChange('./plugins/calc.wasm');
      await vi.waitFor(() => {
        expect(onReload).toHaveBeenCalledWith('calc', './plugins/calc.wasm');
      });
    });

    it('calls onUnload when file is deleted', async () => {
      const onUnload = vi.fn();
      await manager.watch('./plugins/*.wasm', { onUnload });

      const { FileWatcher } = await import('../manager/file-watcher.js');
      const watcherInstance = (FileWatcher as ReturnType<typeof vi.fn>).mock.results[0].value;

      await watcherInstance._callbacks?.onAdd('./plugins/calc.wasm');
      await watcherInstance._callbacks?.onUnlink('./plugins/calc.wasm');

      expect(onUnload).toHaveBeenCalledWith('calc', './plugins/calc.wasm');
      expect(manager.getTool('calc')).toBeUndefined();
    });
  });

  describe('tool execution', () => {
    it('executes the tool and returns result', async () => {
      const tool = await manager.load('./calc.wasm');

      const result = await tool.execute(
        { expression: '2+2' },
        { agentId: 'test', runId: 'run', signal: new AbortController().signal }
      );

      expect(result).toEqual({ result: 'executed-./calc.wasm' });
    });

    it('tool.toJSON() returns valid schema', async () => {
      const tool = await manager.load('./calc.wasm');

      const schema = tool.toJSON();

      expect(schema.name).toBe('calc');
      expect(schema.description).toBe('WASM tool: calc');
      expect(schema.parameters.type).toBe('object');
    });
  });

  describe('close()', () => {
    it('closes watcher and all plugins', async () => {
      await manager.load('./calc.wasm');
      await manager.load('./hash.wasm');
      await manager.watch('./plugins/*.wasm');

      const { FileWatcher } = await import('../manager/file-watcher.js');
      const watcherInstance = (FileWatcher as ReturnType<typeof vi.fn>).mock.results[0].value;

      await manager.close();

      expect(watcherInstance.close).toHaveBeenCalled();
      expect(manager.getTools()).toHaveLength(0);
    });
  });
});
