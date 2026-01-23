import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from '../manager/file-watcher.js';

vi.mock('chokidar', () => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: {
      watch: vi.fn().mockReturnValue(mockWatcher),
    },
  };
});

describe('FileWatcher', () => {
  let watcher: FileWatcher;
  let chokidarMock: typeof import('chokidar');

  beforeEach(async () => {
    vi.useFakeTimers();
    chokidarMock = await import('chokidar');
    watcher = new FileWatcher(100);
  });

  afterEach(async () => {
    await watcher.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('creates a watcher with chokidar', () => {
    const callbacks = {
      onAdd: vi.fn(),
      onChange: vi.fn(),
      onUnlink: vi.fn(),
    };

    watcher.watch('./test/*.wasm', callbacks);

    expect(chokidarMock.default.watch).toHaveBeenCalledWith(
      './test/*.wasm',
      expect.objectContaining({
        persistent: true,
        ignoreInitial: false,
      })
    );
  });

  it('throws if watch is called twice without close', () => {
    const callbacks = {
      onAdd: vi.fn(),
      onChange: vi.fn(),
      onUnlink: vi.fn(),
    };

    watcher.watch('./test/*.wasm', callbacks);
    expect(() => watcher.watch('./other/*.wasm', callbacks)).toThrow('Watcher already started');
  });

  it('debounces add events', async () => {
    const onAdd = vi.fn();
    const callbacks = { onAdd, onChange: vi.fn(), onUnlink: vi.fn() };

    watcher.watch('./test/*.wasm', callbacks);

    const mockWatcher = (chokidarMock.default.watch as ReturnType<typeof vi.fn>).mock.results[0]
      .value;
    const addHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'add')?.[1];

    addHandler('/path/test.wasm');
    addHandler('/path/test.wasm');
    addHandler('/path/test.wasm');

    expect(onAdd).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('/path/test.wasm');
  });

  it('debounces change events', async () => {
    const onChange = vi.fn();
    const callbacks = { onAdd: vi.fn(), onChange, onUnlink: vi.fn() };

    watcher.watch('./test/*.wasm', callbacks);

    const mockWatcher = (chokidarMock.default.watch as ReturnType<typeof vi.fn>).mock.results[0]
      .value;
    const changeHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'change')?.[1];

    changeHandler('/path/test.wasm');
    vi.advanceTimersByTime(50);
    changeHandler('/path/test.wasm');
    vi.advanceTimersByTime(50);
    changeHandler('/path/test.wasm');

    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('calls onUnlink immediately without debounce', () => {
    const onUnlink = vi.fn();
    const callbacks = { onAdd: vi.fn(), onChange: vi.fn(), onUnlink };

    watcher.watch('./test/*.wasm', callbacks);

    const mockWatcher = (chokidarMock.default.watch as ReturnType<typeof vi.fn>).mock.results[0]
      .value;
    const unlinkHandler = mockWatcher.on.mock.calls.find((c: unknown[]) => c[0] === 'unlink')?.[1];

    unlinkHandler('/path/test.wasm');

    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(onUnlink).toHaveBeenCalledWith('/path/test.wasm');
  });

  it('closes chokidar watcher on close()', async () => {
    const callbacks = { onAdd: vi.fn(), onChange: vi.fn(), onUnlink: vi.fn() };

    watcher.watch('./test/*.wasm', callbacks);

    const mockWatcher = (chokidarMock.default.watch as ReturnType<typeof vi.fn>).mock.results[0]
      .value;

    await watcher.close();

    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
