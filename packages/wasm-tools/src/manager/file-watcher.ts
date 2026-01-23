import chokidar, { type FSWatcher } from 'chokidar';
import type { FileWatcherCallbacks } from './types.js';

const DEFAULT_DEBOUNCE_MS = 100;

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;

  constructor(debounceMs: number = DEFAULT_DEBOUNCE_MS) {
    this.debounceMs = debounceMs;
  }

  watch(pattern: string, callbacks: FileWatcherCallbacks): void {
    if (this.watcher) {
      throw new Error('Watcher already started. Call close() first.');
    }

    this.watcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('add', (path) => {
      this.debounce(path, () => callbacks.onAdd(path));
    });

    this.watcher.on('change', (path) => {
      this.debounce(path, () => callbacks.onChange(path));
    });

    this.watcher.on('unlink', (path) => {
      this.clearDebounce(path);
      callbacks.onUnlink(path);
    });
  }

  private debounce(path: string, fn: () => void): void {
    this.clearDebounce(path);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      fn();
    }, this.debounceMs);
    this.debounceTimers.set(path, timer);
  }

  private clearDebounce(path: string): void {
    const existing = this.debounceTimers.get(path);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(path);
    }
  }

  async close(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
