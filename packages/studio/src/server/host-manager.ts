import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HostEvent, HostMessage, HostRequest, HostStatus } from '../protocol.js';

/** Distributes `Omit` over a union, so each request keeps its own fields. */
type WithoutId<T> = T extends unknown ? Omit<T, 'requestId'> : never;

export interface HostManagerOptions {
  projectDir: string;
  studioDir: string;
  /** Restart the host when the project changes (default `true`). */
  watch?: boolean;
  onStatus: (status: HostStatus) => void;
  onEvent: (event: HostEvent) => void;
  /** Runs still going when the host goes away. */
  onLost: (reason: string) => void;
  /** Output of the project's own code. */
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** How long the project may take to load (default 60 s). */
  loadTimeoutMs?: number;
}

/** Files whose change reloads the project. */
const WATCHED_ROOT_FILES = new Set(['cogitator.yml', '.env', 'package.json', 'tsconfig.json']);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.cogitator',
  'dist',
  '.git',
  '.next',
  'coverage',
  'data',
]);
const DEBOUNCE_MS = 250;

/** Whether a change of `path` (relative to the project) should reload it. */
export function reloadsProject(path: string): boolean {
  const parts = path.split(sep).join('/').split('/');
  if (parts.some((part) => IGNORED_DIRS.has(part))) return false;
  if (parts.length === 1) return WATCHED_ROOT_FILES.has(parts[0]);
  return parts[0] === 'src' || parts[0] === 'app' || parts[0] === 'lib';
}

function tsxLoader(projectDir: string): string {
  for (const base of [join(projectDir, 'package.json'), import.meta.url]) {
    try {
      return pathToFileURL(createRequire(base).resolve('tsx')).href;
    } catch {
      continue;
    }
  }
  throw new Error(
    'Cogitator Studio loads the project with tsx, which is not installed: add it with "npm install -D tsx"'
  );
}

function hostEntry(): string {
  const compiled = fileURLToPath(new URL('../host/main.js', import.meta.url));
  return existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL('../host/main.ts', import.meta.url));
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Keeps the runtime host running for the studio: starts it, sends it
 * requests, and starts it again when the project changes, so the studio
 * process and the browser stay while the code reloads.
 */
export class HostManager {
  private child?: ChildProcess;
  private status: HostStatus = { state: 'starting' };
  private readonly pending = new Map<string, Pending>();
  private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private watcher?: FSWatcher;
  private debounce?: ReturnType<typeof setTimeout>;
  private closed = false;
  private generation = 0;

  constructor(private readonly options: HostManagerOptions) {}

  get current(): HostStatus {
    return this.status;
  }

  start(): void {
    this.spawn();
    if (this.options.watch !== false) this.watchProject();
  }

  private setStatus(status: HostStatus): void {
    this.status = status;
    this.options.onStatus(status);
    if (status.state === 'ready') {
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    } else if (status.state === 'failed') {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(status.error));
    }
  }

  private spawn(): void {
    const generation = ++this.generation;
    let loader: string;
    try {
      loader = tsxLoader(this.options.projectDir);
    } catch (error) {
      this.setStatus({
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.setStatus({ state: 'starting' });
    const child = fork(hostEntry(), [this.options.projectDir, this.options.studioDir], {
      cwd: this.options.projectDir,
      execArgv: ['--import', loader, '--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, COGITATOR_STUDIO: '1' },
    });
    this.child = child;
    let stderrTail = '';
    const relay = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString();
      if (stream === 'stderr') stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split('\n')) if (line.trim()) this.options.onOutput?.(line, stream);
    };
    child.stdout?.on('data', relay('stdout'));
    child.stderr?.on('data', relay('stderr'));

    const timer = setTimeout(() => {
      if (generation !== this.generation || this.status.state !== 'starting') return;
      child.kill('SIGKILL');
      this.setStatus({
        state: 'failed',
        error: `The project took longer than ${(this.options.loadTimeoutMs ?? 60_000) / 1000} s to load`,
      });
    }, this.options.loadTimeoutMs ?? 60_000);
    timer.unref();

    child.on('message', (message: HostMessage) => {
      if (generation !== this.generation) return;
      switch (message.type) {
        case 'ready':
          clearTimeout(timer);
          this.setStatus({
            state: 'ready',
            registry: message.registry,
            memory: message.memory,
            loadedAt: Date.now(),
          });
          break;
        case 'load-failed':
          clearTimeout(timer);
          this.setStatus({ state: 'failed', error: message.error });
          break;
        case 'event':
          this.options.onEvent(message.event);
          break;
        case 'response': {
          const pending = this.pending.get(message.requestId);
          if (!pending) break;
          this.pending.delete(message.requestId);
          if (message.ok) pending.resolve(message.data);
          else pending.reject(new Error(message.error));
          break;
        }
      }
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (generation !== this.generation) return;
      this.failPending('The project process stopped');
      this.options.onLost('The project process stopped during the run');
      if (this.closed) return;
      if (this.status.state === 'failed') return;
      const tail = stderrTail.trim().split('\n').slice(-12).join('\n');
      this.setStatus({
        state: 'failed',
        error: `The project process exited (${signal ?? `code ${code}`})${tail ? `:\n${tail}` : ''}`,
      });
    });
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child?.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  /** Starts the host again, with the project as it is now. */
  async restart(reason: string): Promise<void> {
    if (this.closed) return;
    this.generation++;
    this.setStatus({ state: 'restarting', reason });
    this.failPending(`The project reloaded: ${reason}`);
    this.options.onLost(`The project reloaded during the run (${reason})`);
    await this.stopChild();
    if (!this.closed) this.spawn();
  }

  private watchProject(): void {
    try {
      this.watcher = watch(this.options.projectDir, { recursive: true }, (_event, file) => {
        if (!file) return;
        const path = relative(
          this.options.projectDir,
          join(this.options.projectDir, file.toString())
        );
        if (!reloadsProject(path)) return;
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.restart(`${path} changed`), DEBOUNCE_MS);
      });
    } catch (error) {
      this.options.onOutput?.(
        `Cannot watch the project, reload by restarting cogitator dev: ${error instanceof Error ? error.message : String(error)}`,
        'stderr'
      );
    }
  }

  /** Resolves once the project is loaded; rejects when it failed to load. */
  ready(timeoutMs = 90_000): Promise<void> {
    if (this.status.state === 'ready') return Promise.resolve();
    if (this.status.state === 'failed') return Promise.reject(new Error(this.status.error));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The project is still loading')), timeoutMs);
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Sends a request to the host once the project is loaded. */
  async request<T>(request: WithoutId<HostRequest>): Promise<T> {
    await this.ready();
    const child = this.child;
    if (!child?.connected) throw new Error('The project process is not running');
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: (data) => resolve(data as T), reject });
      child.send({ ...request, requestId } as HostRequest, (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.failPending('Cogitator Studio is closing');
    await this.stopChild();
  }
}
