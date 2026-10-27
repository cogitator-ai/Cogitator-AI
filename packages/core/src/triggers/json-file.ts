/**
 * A JSON file several processes share: the CLI changes a schedule while a runtime polls it. Each
 * change takes a lock file, reads the file as it is now, writes the result to a temporary file
 * and renames it over the old one, so nobody reads a torn file or loses another's change. Reads
 * come from a cache that is read again when the file changed
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this was left by a process that died: it is taken over */
const STALE_LOCK_MS = 30_000;

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options of {@link SharedJsonFile} */
export interface SharedJsonFileOptions<T> {
  /** The value of a file that does not exist yet */
  empty: () => T;
  /** Checks what was read, throwing for a file that is not the store's */
  parse?: (value: unknown) => T;
  /** The file's mode, `0o600` by default: stores keep token hashes and results */
  mode?: number;
  /** How the file is written, two-space JSON by default */
  stringify?: (value: T) => string;
}

export class SharedJsonFile<T> {
  private cached?: { signature: string; value: T };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly options: SharedJsonFileOptions<T>
  ) {}

  /** The file's contents, read again only when it changed */
  async read(): Promise<T> {
    const signature = await this.signature();
    if (signature === null) return this.options.empty();
    if (this.cached?.signature === signature) return this.cached.value;
    const value = await this.load();
    this.cached = { signature, value };
    return value;
  }

  /**
   * Changes the file under its lock: `change` gets the contents as they are now and changes them
   * in place, its result is returned once the file is written
   */
  update<R>(change: (value: T) => R | Promise<R>): Promise<R> {
    const run = this.queue.then(() => this.locked(change));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async locked<R>(change: (value: T) => R | Promise<R>): Promise<R> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const release = await this.lock();
    try {
      const value = (await this.signature()) === null ? this.options.empty() : await this.load();
      const result = await change(value);
      await this.write(value);
      return result;
    } finally {
      await release();
    }
  }

  private async signature(): Promise<string | null> {
    try {
      const stat = await fs.stat(this.path);
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private async load(): Promise<T> {
    const raw = await fs.readFile(this.path, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`${this.path} is not valid JSON`, { cause: error });
    }
    return this.options.parse ? this.options.parse(parsed) : (parsed as T);
  }

  private async write(value: T): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const text = this.options.stringify
      ? this.options.stringify(value)
      : JSON.stringify(value, null, 2);
    try {
      await fs.writeFile(temporary, text, { mode: this.options.mode ?? 0o600 });
      await fs.rename(temporary, this.path);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const signature = await this.signature();
    if (signature !== null) this.cached = { signature, value };
  }

  private async lock(): Promise<() => Promise<void>> {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return () => fs.rm(lockPath, { force: true });
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (error) {
        if (!isCode(error, 'ENOENT')) throw error;
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`${lockPath} is held by another process for more than 10 s`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}
