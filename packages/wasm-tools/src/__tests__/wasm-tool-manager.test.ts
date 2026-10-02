import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WasmToolManager } from '../manager/wasm-tool-manager.js';

let mockWatcherInstance: {
  _callbacks: {
    onAdd: (p: string) => void;
    onChange: (p: string) => void;
    onUnlink: (p: string) => void;
  } | null;
  watch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} | null = null;

vi.mock('../manager/wasm-loader.js', () => {
  class WasmLoader {
    initialize = vi.fn().mockResolvedValue(undefined);
    load = vi.fn().mockImplementation((path: string) => {
      return Promise.resolve({
        call: vi.fn().mockResolvedValue({
          text: () => JSON.stringify({ result: `executed-${path}` }),
          bytes: () => new Uint8Array(),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      });
    });
  }
  return { WasmLoader };
});

vi.mock('../manager/file-watcher.js', () => {
  class FileWatcher {
    _callbacks: {
      onAdd: (p: string) => void;
      onChange: (p: string) => void;
      onUnlink: (p: string) => void;
    } | null = null;
    watch = vi.fn().mockImplementation(
      (
        _pattern: string,
        callbacks: {
          onAdd: (p: string) => void;
          onChange: (p: string) => void;
          onUnlink: (p: string) => void;
        }
      ) => {
        mockWatcherInstance!._callbacks = callbacks;
      }
    );
    close = vi.fn().mockResolvedValue(undefined);

    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      mockWatcherInstance = this;
    }
  }
  return { FileWatcher };
});

describe('WasmToolManager', () => {
  let manager: WasmToolManager;

  beforeEach(() => {
    mockWatcherInstance = null;
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
      await manager.watch('./plugins/*.wasm');

      expect(mockWatcherInstance).not.toBeNull();
      expect(mockWatcherInstance!.watch).toHaveBeenCalledWith(
        './plugins/*.wasm',
        expect.any(Object)
      );
    });

    it('throws if watch called twice', async () => {
      await manager.watch('./plugins/*.wasm');
      await expect(manager.watch('./other/*.wasm')).rejects.toThrow('Already watching');
    });

    it('calls onLoad when file is added', async () => {
      const onLoad = vi.fn();
      await manager.watch('./plugins/*.wasm', { onLoad });

      mockWatcherInstance!._callbacks?.onAdd('./plugins/calc.wasm');
      await vi.waitFor(() => {
        expect(onLoad).toHaveBeenCalledWith('calc', './plugins/calc.wasm');
      });
    });

    it('calls onReload when file changes', async () => {
      const onReload = vi.fn();
      await manager.watch('./plugins/*.wasm', { onReload });

      mockWatcherInstance!._callbacks?.onAdd('./plugins/calc.wasm');
      await vi.waitFor(() => {
        expect(manager.getTool('calc')).toBeDefined();
      });

      mockWatcherInstance!._callbacks?.onChange('./plugins/calc.wasm');
      await vi.waitFor(() => {
        expect(onReload).toHaveBeenCalledWith('calc', './plugins/calc.wasm');
      });
    });

    it('calls onUnload when file is deleted', async () => {
      const onUnload = vi.fn();
      await manager.watch('./plugins/*.wasm', { onUnload });

      mockWatcherInstance!._callbacks?.onAdd('./plugins/calc.wasm');
      await vi.waitFor(
        () => {
          expect(manager.getTool('calc')).toBeDefined();
        },
        { timeout: 1000 }
      );

      mockWatcherInstance!._callbacks?.onUnlink('./plugins/calc.wasm');
      await vi.waitFor(
        () => {
          expect(onUnload).toHaveBeenCalledWith('calc', './plugins/calc.wasm');
        },
        { timeout: 1000 }
      );
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

      await manager.close();

      expect(mockWatcherInstance!.close).toHaveBeenCalled();
      expect(manager.getTools()).toHaveLength(0);
    });
  });

  describe('timeouts and aborts', () => {
    it('rejects invalid timeout options', () => {
      expect(() => new WasmToolManager({ timeout: 0 })).toThrow('timeout');
    });

    it('times out a hung call and replaces the plugin so the tool keeps working', async () => {
      const timed = new WasmToolManager({ timeout: 20 });
      try {
        const tool = await timed.load('./hang.wasm');
        const original = timed.getModule('hang')!.plugin;
        (original.call as ReturnType<typeof vi.fn>).mockImplementationOnce(
          () => new Promise(() => undefined)
        );

        await expect(tool.execute({}, undefined as never)).rejects.toThrow(
          'WASM tool hang timed out after 20ms'
        );
        await vi.waitFor(() => expect(timed.getModule('hang')!.plugin).not.toBe(original));
        expect(original.close).toHaveBeenCalled();

        await expect(tool.execute({}, undefined as never)).resolves.toEqual({
          result: 'executed-./hang.wasm',
        });
      } finally {
        await timed.close();
      }
    });

    it('aborts a running call via the tool context signal and recycles the plugin', async () => {
      const tool = await manager.load('./slow.wasm');
      const original = manager.getModule('slow')!.plugin;
      (original.call as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise(() => undefined)
      );
      const controller = new AbortController();

      const pending = tool.execute({}, { agentId: 'a', runId: 'r', signal: controller.signal });
      controller.abort();

      await expect(pending).rejects.toThrow('WASM tool slow aborted');
      await vi.waitFor(() => expect(manager.getModule('slow')!.plugin).not.toBe(original));
    });
  });
});
